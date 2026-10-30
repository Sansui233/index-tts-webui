"""Check indextts.batch against the original decoder, then measure throughput.

uv run scripts/bench_batch.py [--quick] [--rows=8]

1. parity: greedy, one row -> same codes as UnifiedVoice.inference_speech (greedy, 1 beam)
2. mixed batch: greedy sentences with different voices and lengths, one joining
   mid-way -> codes compared with their single-row runs
3. throughput: n concurrent jobs (sampling, best-of-1 and best-of-3) against the
   original infer() (beam 3) run one after another
"""

import sys
import time
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from indextts.batch import Job, Scheduler  # noqa: E402
from indextts.infer import IndexTTS  # noqa: E402

VOICES = [ROOT / "samples/example1.wav", ROOT / "samples/_原神/林尼 - 唉呀.wav"]
TEXTS = [
    "你好。",
    "今天天气不错，我们出去走走吧。",
    "在很久很久以前，有一座被云雾环绕的山，山上住着一位不愿意下山的老人，他每天都在等一封信。",
    "There is a vehicle arriving in dock number seven.",
    "风停了，雨也停了，可是她还站在门口，一句话也没有说。",
    "好的，我知道了，明天见。",
    "这个问题其实没有那么复杂，只要把它拆成几个小步骤，一步一步来就可以了。",
    "嗯。",
]
GREEDY = {"do_sample": False, "num_beams": 1, "repetition_penalty": 10.0, "max_mel_tokens": 600}
SAMPLE = {"do_sample": True, "top_p": 0.8, "top_k": 30, "temperature": 1.0, "repetition_penalty": 10.0, "max_mel_tokens": 600}


def run(scheduler, jobs, join_later=(), after=20):
    """Submit `jobs`, then `join_later` after `after` steps; step until idle."""
    for job in jobs:
        scheduler.submit(job)
    steps = 0
    while scheduler.busy() or join_later:
        if steps == after:
            for job in join_later:
                scheduler.submit(job)
            join_later = ()
        scheduler.step()
        steps += 1
    for job in [*jobs]:
        assert job.done.is_set() and job.error is None, job.error
    return steps


def reference_codes(tts, voice, text):
    """Greedy codes from the original decoder for a one-sentence text."""
    import torchaudio
    from indextts.utils.feature_extractors import MelSpectrogramFeatures

    audio, sr = torchaudio.load(str(voice))
    audio = torchaudio.transforms.Resample(sr, 24000)(torch.mean(audio, dim=0, keepdim=True))
    cond_mel = MelSpectrogramFeatures()(audio).to(tts.device)
    tokens = tts.tokenizer.convert_tokens_to_ids(tts.tokenizer.tokenize(text))
    text_tokens = torch.tensor(tokens, dtype=torch.int32, device=tts.device)[None]
    with torch.no_grad(), torch.amp.autocast("cuda", enabled=tts.dtype is not None, dtype=tts.dtype):
        codes = tts.gpt.inference_speech(cond_mel, text_tokens, cond_mel_lengths=torch.tensor([cond_mel.shape[-1]], device=tts.device),
                                         do_sample=False, num_beams=1, repetition_penalty=10.0, max_generate_length=600)
    codes = codes[0].tolist()
    return codes[: codes.index(tts.stop_mel_token) + 1] if tts.stop_mel_token in codes else codes


def agreement(a, b):
    same = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
    return f"{same}/{max(len(a), len(b))} tokens agree" + ("" if a == b else "  <-- differs")


def main():
    quick = "--quick" in sys.argv
    tts = IndexTTS(model_dir=str(ROOT / "checkpoints"), cfg_path=str(ROOT / "checkpoints/config.yaml"), use_cuda_kernel=False)
    rows = int(next((a.split("=")[1] for a in sys.argv if a.startswith("--rows=")), 8))
    scheduler = Scheduler(tts, max_rows=rows)

    print("\n== 1. parity (greedy, single row) ==")
    singles = {}
    for voice in VOICES:
        for text in TEXTS[:4]:
            job = Job(voice, text, GREEDY)
            run(scheduler, [job])
            singles[(voice, text)] = job.codes[0]
            print(f"{voice.name[:12]:12} {text[:16]:16} {agreement(job.codes[0], reference_codes(tts, voice, text))}")

    print("\n== 2. mixed batch (greedy; voices, lengths, one joins after 20 steps) ==")
    pairs = [(VOICES[i % 2], TEXTS[i]) for i in range(4)]
    jobs = [Job(v, t, GREEDY) for v, t in pairs[:3]]
    late = [Job(pairs[3][0], pairs[3][1], GREEDY)]
    run(scheduler, jobs, late)
    for (voice, text), job in zip(pairs, jobs + late):
        print(f"{voice.name[:12]:12} {text[:16]:16} {agreement(job.codes[0], singles[(voice, text)])}")

    print("\n== 3. throughput ==")
    sizes = [1, 4] if quick else [1, 4, 8]
    for best_of in (1, 3):
        for n in sizes:
            jobs = [Job(VOICES[i % 2], TEXTS[i % len(TEXTS)], {**SAMPLE, "num_beams": best_of}) for i in range(n)]
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()
            start = time.perf_counter()
            run(scheduler, jobs)
            torch.cuda.synchronize()
            elapsed = time.perf_counter() - start
            seconds = sum(j.wav.shape[-1] for j in jobs) / 24000
            print(f"best-of-{best_of} x{n}: {elapsed:6.2f}s for {seconds:5.1f}s audio  RTF {elapsed / seconds:.3f}"
                  f"  peak {torch.cuda.max_memory_allocated() / 2**30:.2f} GiB")
    for n in sizes:
        out = ROOT / "data/bench_old.wav"
        torch.cuda.synchronize()
        start = time.perf_counter()
        for i in range(n):
            tts.infer(str(VOICES[i % 2]), TEXTS[i % len(TEXTS)], str(out))
        torch.cuda.synchronize()
        print(f"original infer (beam 3) x{n} sequential: {time.perf_counter() - start:6.2f}s")
        out.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
