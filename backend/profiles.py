"""听书配置: an API's saved voices as TTS engine configs for reader apps. Formats follow
yy4382/tts-importer. 阅读 (legado) and 服务端阅读 (hectorqin/reader) share legado's httpTTS
JSON; 爱阅记 uses a JxdAdvCustomTTS config with one voice list.

Private APIs POST form fields (voice, text) with the bearer token in a header: the apps
substitute the text into the request before sending, which a JSON body would not survive."""

import json
import secrets
import time
from urllib.parse import quote, urlparse

APPS = ("legado", "ireadnote")
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def ulid():
    """26-char ULID (48-bit ms time + 80 random bits), as 爱阅记 config ids are."""
    value = (int(time.time() * 1000) << 80) | secrets.randbits(80)
    return "".join(CROCKFORD[(value >> shift) & 31] for shift in range(125, -1, -5))


def endpoint(api, base):
    return f"{base.rstrip('/')}/tts/{api['slug']}"


def legado(api, base):
    """One httpTTS entry per saved voice. `{{…}}` is evaluated by the app; speakText is the
    sentence. The response type is checked against contentType."""
    url, start = endpoint(api, base), int(time.time()) * 1000
    text = "{{encodeURIComponent(speakText)}}"
    headers = {"Authorization": f"Bearer {api['token']}"} if api["access"] == "private" else {}
    entries = []
    for index, voice in enumerate(api["voices"]):
        if api["access"] == "private":
            option = {"method": "POST", "body": f"voice={quote(voice['name'], safe='')}&text={text}", "headers": headers}
            address = f"{url},{json.dumps(option, ensure_ascii=False)}"
        else:
            address = f"{url}?voice={quote(voice['name'], safe='')}&text={text}"
        entries.append(
            {
                "id": start + index,
                "name": f"{api['name']} · {voice['name']}",
                "url": address,
                "contentType": "audio/wav",
                "concurrentRate": "0",
                "header": json.dumps(headers, ensure_ascii=False) if headers else "",
                "loginUrl": "",
                "loginUi": "",
                "loginCheckJs": "",
            }
        )
    return entries


def ireadnote(api, base):
    """One engine with every saved voice: `%@` is the text, `@json:voiceName` the voice
    picked from voiceList (a single voice is written in directly)."""
    voices = [v["name"] for v in api["voices"]]
    handle = {
        "processType": 1,
        "forGetMethod": 1 if api["access"] == "public" else 0,
        "url": endpoint(api, base),
        "params": {"voice": voices[0] if len(voices) == 1 else "@json:voiceName", "text": "%@"},
        "parser": {"playData": "ResponseData"},
    }
    if api["access"] == "private":
        handle["httpConfigs"] = {"headers": {"Authorization": f"Bearer {api['token']}"}}
    config = {
        "_ClassName": "JxdAdvCustomTTS",
        "_TTSConfigID": ulid(),
        "_TTSName": api["name"],
        "ttsConfigGroup": "IndexTTS",
        "ttsHandles": [handle],
    }
    if len(voices) > 1:
        config["voiceList"] = [{"name": v, "display": v} for v in voices]
    return config


def profile(api, app, base):
    address = urlparse(base)
    if address.scheme not in ("http", "https") or not address.netloc:
        raise ValueError("服务器地址需以 http:// 或 https:// 开头")
    if app not in APPS:
        raise KeyError(f"未知应用：{app}")
    if not api["voices"]:
        raise ValueError("这个 API 还没有保存的音色，请先生成链接")
    if api["access"] == "private" and not api.get("token"):
        raise ValueError("私有 API 缺少 token")
    return legado(api, base) if app == "legado" else ireadnote(api, base)
