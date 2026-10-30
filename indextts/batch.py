"""Continuous batching for IndexTTS 1.5 GPT decoding.

A sentence joins the running batch between decode steps and leaves it as soon as it
stops, so short sentences never wait for long ones. Each row samples with its own
parameters. best-of-N decodes one sentence as N independent sampled rows and keeps the
one with the highest mean log prob (no beam search: rows never swap KV).

Only the components of `UnifiedVoice` are used, never `GPT2InferenceModel` or the
`IndexTTS` prompt cache, so this runs safely beside the original `infer` path.
Not thread-safe by itself: one thread calls `submit()` and `step()`.
"""

from collections import OrderedDict
from os import stat
from threading import Event

import torch
import torch.nn.functional as F
import torchaudio

from indextts.utils.feature_extractors import MelSpectrogramFeatures

SAMPLE_RATE = 24000
# Once the first row of a best-of-N group stops at length L, the others may run to this
# multiple of L before they are dropped as runaway.
RUNAWAY = 1.5
CACHE_SIZE = 16


class Cancelled(Exception):
    pass


class Job:
    """One synthesis call: `text` in the voice of `source`, split into sentences.
    `settings` uses the WebUI generation fields; `num_beams` means best-of-N here."""

    def __init__(self, source, text, settings):
        self.source, self.text = str(source), text
        self.do_sample = bool(settings.get("do_sample", True))
        self.top_p = float(settings.get("top_p", 0.8))
        self.top_k = int(settings.get("top_k") or 0)
        self.temperature = float(settings.get("temperature", 1.0))
        self.repetition_penalty = float(settings.get("repetition_penalty", 10.0))
        self.max_mel_tokens = int(settings.get("max_mel_tokens", 600))
        self.max_text_tokens = int(settings.get("max_text_tokens_per_sentence", 120))
        self.best_of = max(1, int(settings.get("num_beams", 1)))
        self.done = Event()
        self.cancelled = False
        self.error = None
        self.wav = None  # int16-range float tensor [1, samples] on CPU
        self.total = self.finished = 0
        self.wavs, self.codes = [], []  # per sentence; codes = the winning row's tokens

    def progress(self):
        return self.finished / self.total if self.total else 0.0

    def fail(self, error):
        self.error = error
        self.done.set()


class _Sentence:
    def __init__(self, job, index, ids):
        self.job, self.index, self.ids = job, index, ids
        self.rows, self.limit = [], None


class _Row:
    def __init__(self, sentence):
        self.sentence = sentence
        self.codes = []
        self.logprob = 0.0
        self.finished = self.stopped = False

    def score(self):
        return self.logprob / max(1, len(self.codes))


class Scheduler:
    def __init__(self, tts, max_rows=8):
        self.tts, self.max_rows = tts, max_rows
        self.gpt = tts.gpt  # UnifiedVoice
        self.device = tts.device
        self.stop = self.gpt.stop_mel_token
        self.start = self.gpt.start_mel_token
        # mel positions run to k + 1 for the k-th generated token
        self.mel_limit = self.gpt.mel_pos_embedding.emb.num_embeddings - 2
        self.conds = OrderedDict()  # (path, mtime) -> (cond_mel, cond_latent)
        self.waiting = []  # sentences not yet admitted, in submit order
        self.jobs = []
        self.rows = []  # one per batch index
        self.past = None  # tuple of (key, value) per layer: [B, heads, T, dim]
        self.mask = None  # [B, T], 0 = left padding
        self.seen = None  # [B, vocab] bool: tokens the repetition penalty applies to
        self.params = None  # per-row sampling tensors, rebuilt when rows change

    def autocast(self):
        return torch.amp.autocast(torch.device(self.device).type, enabled=self.tts.dtype is not None, dtype=self.tts.dtype)

    def busy(self):
        return bool(self.rows or self.waiting)

    def submit(self, job):
        tokenizer = self.tts.tokenizer
        tokens = tokenizer.tokenize(job.text)
        sentences = [s for s in tokenizer.split_sentences(tokens, job.max_text_tokens) if s]
        if not sentences:
            job.fail(ValueError("没有可合成的文本"))
            return
        job.total = len(sentences)
        job.wavs, job.codes = [None] * job.total, [None] * job.total
        job.best_of = min(job.best_of, self.max_rows)
        job.max_mel_tokens = min(job.max_mel_tokens, self.mel_limit)
        self.jobs.append(job)
        for index, sentence in enumerate(sentences):
            self.waiting.append(_Sentence(job, index, tokenizer.convert_tokens_to_ids(sentence)))

    def step(self):
        """Drop cancelled work, admit what fits, decode one token for every row."""
        self._reap()
        while self.waiting and len(self.rows) + self.waiting[0].job.best_of <= self.max_rows:
            self._admit(self.waiting.pop(0))
        self._settle()  # a row may stop on its first token
        if self.rows:
            self._decode()

    def fail_all(self, error):
        for job in self.jobs:
            job.fail(error)
        self.jobs, self.waiting, self.rows = [], [], []
        self.past = self.mask = self.seen = self.params = None

    # ---- conditioning -------------------------------------------------

    def _condition(self, path):
        key = (path, stat(path).st_mtime_ns)
        if key in self.conds:
            self.conds.move_to_end(key)
            return self.conds[key]
        audio, sr = torchaudio.load(path)
        audio = torch.mean(audio, dim=0, keepdim=True)
        audio = torchaudio.transforms.Resample(sr, SAMPLE_RATE)(audio)
        cond_mel = MelSpectrogramFeatures()(audio).to(self.device)
        with torch.no_grad(), self.autocast():
            latent = self.gpt.get_conditioning(cond_mel, torch.tensor([cond_mel.shape[-1]], device=self.device))
        self.conds[key] = (cond_mel, latent)
        if len(self.conds) > CACHE_SIZE:
            self.conds.popitem(last=False)
        return cond_mel, latent

    # ---- batch membership --------------------------------------------

    def _admit(self, sentence):
        job = sentence.job
        try:
            _, latent = self._condition(job.source)
        except Exception as error:
            self._cancel_job(job, error)
            return
        gpt = self.gpt
        # Same prompt as UnifiedVoice.prepare_gpt_inputs: [cond][start_text text stop_text][start_mel]
        ids = [i for i in sentence.ids if i not in (gpt.start_text_token, gpt.stop_text_token)]
        text = torch.tensor([gpt.start_text_token, *ids, gpt.stop_text_token], device=self.device)
        with torch.no_grad(), self.autocast():
            text_emb = gpt.text_embedding(text) + gpt.text_pos_embedding.emb(torch.arange(text.shape[0], device=self.device))
            start = gpt.mel_embedding(torch.tensor([self.start], device=self.device)) + gpt.mel_pos_embedding.emb(
                torch.zeros(1, dtype=torch.long, device=self.device)
            )
            emb = torch.cat([latent[0].to(text_emb.dtype), text_emb, start.to(text_emb.dtype)])[None]
            mask = torch.ones(1, emb.shape[1], dtype=torch.long, device=self.device)
            out = gpt.gpt(inputs_embeds=emb, attention_mask=mask, use_cache=True, return_dict=True)
            logits = gpt.mel_head(gpt.final_norm(out.last_hidden_state[:, -1]))
        n = job.best_of
        rows = [_Row(sentence) for _ in range(n)]
        sentence.rows = rows
        past = tuple((k.expand(n, -1, -1, -1), v.expand(n, -1, -1, -1)) for k, v in out.past_key_values)
        seen = torch.zeros(n, logits.shape[-1], dtype=torch.bool, device=self.device)
        seen[:, 1] = True  # generate()'s placeholder prompt ids are all 1
        seen[:, self.start] = True
        self._merge(rows, past, mask.expand(n, -1), seen)
        # Sample the first token of the new rows from the prefill logits.
        first = len(self.rows) - n
        self._sample(logits.float().expand(n, -1), range(first, len(self.rows)))

    def _merge(self, rows, past, mask, seen):
        if self.past is None:
            self.past = tuple((k.contiguous(), v.contiguous()) for k, v in past)
            self.mask, self.seen, self.rows = mask.contiguous(), seen, list(rows)
        else:
            width = max(self.mask.shape[1], mask.shape[1])
            pad = lambda x, dim: F.pad(x, (0, 0, width - x.shape[dim], 0)) if dim == 2 else F.pad(x, (width - x.shape[1], 0))
            self.past = tuple(
                (torch.cat([pad(k0, 2), pad(k1, 2)]), torch.cat([pad(v0, 2), pad(v1, 2)]))
                for (k0, v0), (k1, v1) in zip(self.past, past)
            )
            self.mask = torch.cat([pad(self.mask, 1), pad(mask, 1)])
            self.seen = torch.cat([self.seen, seen])
            self.rows += rows
        self.params = None

    def _keep(self, keep):
        """Keep batch rows `keep` (indices), trimming left columns no row uses."""
        if len(keep) == len(self.rows):
            return
        if not keep:
            self.rows, self.past, self.mask, self.seen, self.params = [], None, None, None, None
            return
        index = torch.tensor(keep, device=self.device)
        mask = self.mask.index_select(0, index)
        left = int(mask.any(0).nonzero()[0])
        self.mask = mask[:, left:]
        self.past = tuple(
            (k.index_select(0, index)[:, :, left:], v.index_select(0, index)[:, :, left:]) for k, v in self.past
        )
        self.seen = self.seen.index_select(0, index)
        self.rows = [self.rows[i] for i in keep]
        self.params = None

    def _reap(self):
        for job in [j for j in self.jobs if j.cancelled]:
            self._cancel_job(job, Cancelled())

    def _cancel_job(self, job, error):
        self.waiting = [s for s in self.waiting if s.job is not job]
        self._keep([i for i, r in enumerate(self.rows) if r.sentence.job is not job])
        if job in self.jobs:
            self.jobs.remove(job)
        job.fail(error)

    # ---- decoding -----------------------------------------------------

    def _decode(self):
        gpt = self.gpt
        tokens = torch.tensor([r.codes[-1] for r in self.rows], device=self.device)
        positions = torch.tensor([len(r.codes) + 1 for r in self.rows], device=self.device)
        self.mask = F.pad(self.mask, (0, 1), value=1)
        with torch.no_grad(), self.autocast():
            emb = gpt.mel_embedding(tokens) + gpt.mel_pos_embedding.emb(positions)
            out = gpt.gpt(inputs_embeds=emb[:, None], past_key_values=self.past, attention_mask=self.mask,
                          use_cache=True, return_dict=True)
            logits = gpt.mel_head(gpt.final_norm(out.last_hidden_state[:, -1]))
        self.past = out.past_key_values
        self._sample(logits.float(), range(len(self.rows)))
        self._settle()

    def _tensors(self):
        if self.params is None:
            jobs = [r.sentence.job for r in self.rows]
            column = lambda values, dtype=torch.float32: torch.tensor(values, dtype=dtype, device=self.device)[:, None]
            self.params = {
                "penalty": column([j.repetition_penalty for j in jobs]),
                "temperature": column([j.temperature for j in jobs]),
                "top_k": column([j.top_k for j in jobs], torch.long),
                "top_p": column([j.top_p for j in jobs]),
                "sample": column([j.do_sample for j in jobs], torch.bool)[:, 0],
            }
        return self.params

    def _sample(self, logits, indices):
        """Pick the next token for batch rows `indices` (logits: one row each, float32).
        Same order as transformers 4.36 sampling: repetition penalty, temperature,
        top-k, top-p, then multinomial (argmax when do_sample is off)."""
        indices = list(indices)
        index = torch.tensor(indices, device=self.device)
        p = {k: v.index_select(0, index) for k, v in self._tensors().items()}
        seen = self.seen.index_select(0, index)
        logprobs = torch.log_softmax(logits, dim=-1)
        penalized = torch.where(logits < 0, logits * p["penalty"], logits / p["penalty"])
        scores = torch.where(seen, penalized, logits)
        greedy = scores.argmax(-1)
        scores = scores / p["temperature"]
        top_k = p["top_k"].clamp(max=scores.shape[-1])
        kth = scores.sort(-1, descending=True).values.gather(1, (top_k - 1).clamp(min=0))
        scores = scores.masked_fill((top_k > 0) & (scores < kth), float("-inf"))
        ordered, order = scores.sort(-1)
        cumulative = ordered.softmax(-1).cumsum(-1)
        drop = cumulative <= (1 - p["top_p"])
        drop[:, -1] = False
        scores = scores.masked_fill(drop.scatter(1, order, drop), float("-inf"))
        sampled = torch.multinomial(scores.softmax(-1), 1)[:, 0]
        chosen = torch.where(p["sample"], sampled, greedy)
        self.seen[index, chosen] = True
        picked = logprobs.gather(1, chosen[:, None])[:, 0]
        for i, token, logprob in zip(indices, chosen.tolist(), picked.tolist()):
            row = self.rows[i]
            row.codes.append(token)
            row.logprob += logprob
            job = row.sentence.job
            if token == self.stop:
                row.finished = row.stopped = True
            elif len(row.codes) >= job.max_mel_tokens:
                row.finished = True

    def _settle(self):
        """Apply runaway limits, retire finished rows, finish complete sentences."""
        for row in self.rows:
            sentence = row.sentence
            if row.stopped and sentence.limit is None and len(sentence.rows) > 1:
                sentence.limit = int(len(row.codes) * RUNAWAY) + 10
        for row in self.rows:
            limit = row.sentence.limit
            if not row.finished and limit is not None and len(row.codes) >= limit:
                row.finished = True
        done = {id(r.sentence): r.sentence for r in self.rows if r.finished}
        if not done:
            return
        self._keep([i for i, r in enumerate(self.rows) if not r.finished])
        for sentence in done.values():
            if all(r.finished for r in sentence.rows):
                self._finish(sentence)

    def _finish(self, sentence):
        job = sentence.job
        if job.done.is_set():
            return
        stopped = [r for r in sentence.rows if r.stopped] or sentence.rows
        best = max(stopped, key=_Row.score)
        job.codes[sentence.index] = best.codes
        try:
            job.wavs[sentence.index] = self._vocode(job, sentence, best.codes)
        except Exception as error:
            self._cancel_job(job, error)
            return
        job.finished += 1
        if job.finished == job.total:
            job.wav = torch.cat(job.wavs, dim=1)
            job.wavs = []
            self.jobs.remove(job)
            job.done.set()

    def _vocode(self, job, sentence, codes):
        """Codes -> waveform, exactly as IndexTTS.infer does after generation."""
        cond_mel, _ = self._condition(job.source)
        codes = torch.tensor([codes], device=self.device)
        codes, code_lens = self.tts.remove_long_silence(codes, silent_token=52, max_consecutive=30)
        text = torch.tensor([sentence.ids], dtype=torch.int32, device=self.device)
        frames = torch.tensor([cond_mel.shape[-1]], device=self.device)
        with torch.no_grad(), self.autocast():
            latent = self.gpt(cond_mel, text, torch.tensor([text.shape[-1]], device=self.device), codes,
                              code_lens * self.gpt.mel_length_compression, cond_mel_lengths=frames,
                              return_latent=True, clip_inputs=False)
            wav, _ = self.tts.bigvgan(latent, cond_mel.transpose(1, 2))
        return torch.clamp(32767 * wav.squeeze(1), -32767.0, 32767.0).cpu()
