"""External TTS APIs: access modes, voice resolution, saved voices and 听书配置."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from fastapi.testclient import TestClient
from backend import audio as audio_module, library as library_module
from backend.app import create_app


class Engine:
    def __init__(self):
        self.calls = []

    def status(self):
        return {"state": "loaded", "error": None}

    def infer(self, source, text, output, settings, progress):
        self.calls.append((Path(source).name, text, settings))
        self.output = Path(output)
        Path(output).write_bytes(b"RIFF" + text.encode())


class ApiTest(unittest.TestCase):
    def setUp(self):
        temp = Path(tempfile.mkdtemp())
        self.samples = (temp / "samples").resolve()
        for relative in ("卡维/a.wav", "_other/x.wav"):
            (self.samples / relative).parent.mkdir(parents=True, exist_ok=True)
            (self.samples / relative).write_bytes(relative.encode())
        for module in (audio_module, library_module):
            patch = mock.patch.object(module, "SAMPLES", self.samples)
            patch.start()
            self.addCleanup(patch.stop)
        self.engine = Engine()
        self.data = temp / "data"
        self.client = TestClient(create_app(self.data, self.engine))
        self.audio = self.request("POST", "/audio/import", {"path": "卡维/a.wav"})["id"]

    def request(self, method, path, body=None, status=200):
        response = self.client.request(method, "/api" + path, json=body)
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def create(self, **fields):
        return self.request("POST", "/apis", {"name": "n", "slug": "live", **fields})

    def test_public_get_and_post(self):
        self.create(voices=[{"name": "kv", "audio_id": self.audio}])
        response = self.client.get("/tts/live", params={"text": "你好", "voice": "kv"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, "RIFF你好".encode())
        self.assertEqual(response.headers["content-type"], "audio/wav")
        self.assertFalse(self.engine.output.exists())  # temp file deleted once sent
        response = self.client.post("/tts/LIVE", json={"text": "再见", "voice": "kv", "generation": {"mode": "fast"}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.engine.calls[-1][2]["mode"], "fast")
        task = self.request("GET", f"/tasks/{response.headers['x-task-id']}")
        self.assertEqual((task["kind"], task["title"]), ("api", "n · 再见"))

    def test_any_reference_audio(self):
        self.create()
        for voice, file in ((self.audio, "a.wav"), ("_other/x.wav", "x.wav")):
            response = self.client.get("/tts/live", params={"text": "t", "voice": voice})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(self.engine.calls[-1][0], file)
        self.assertEqual(self.client.get("/tts/live", params={"text": "t", "voice": "nope.wav"}).status_code, 404)
        # API audio is never stored: no record, no file.
        self.assertTrue(all(a.get("source") == "samples" for a in self.request("GET", "/audio")))
        self.assertFalse(any(self.data.rglob("*.wav")))
        # Generated outputs are not reference audio.
        task = self.request("POST", "/speech", {"text": "t", "audio_id": self.audio}, status=202)
        output = self.client.app.state.services.tasks.wait(task["id"], 5)["result"]
        self.assertTrue(output["path"].startswith("outputs/"))
        self.assertEqual(self.client.get("/tts/live", params={"text": "t", "voice": output["id"]}).status_code, 404)

    def test_private_needs_post_and_token(self):
        api = self.create(access="private")
        token = api["token"]
        self.assertTrue(token)
        body = {"text": "t", "voice": self.audio}
        self.assertEqual(self.client.get("/tts/live", params=body, headers={"Authorization": f"Bearer {token}"}).status_code, 405)
        self.assertEqual(self.client.post("/tts/live", json=body).status_code, 401)
        self.assertEqual(self.client.post("/tts/live", json=body, headers={"Authorization": "Bearer wrong"}).status_code, 401)
        self.assertEqual(self.client.post("/tts/live", json=body, headers={"Authorization": f"Bearer {token}"}).status_code, 200)
        fresh = self.request("POST", f"/apis/{api['id']}/token")["token"]
        self.assertEqual(self.client.post("/tts/live", json=body, headers={"Authorization": f"Bearer {token}"}).status_code, 401)
        # Switching to public and back keeps the token.
        fields = {"name": "n", "slug": "live"}
        self.request("PUT", f"/apis/{api['id']}", {**fields, "access": "public"})
        self.assertEqual(self.request("PUT", f"/apis/{api['id']}", {**fields, "access": "private"})["token"], fresh)

    def test_voice_listing(self):
        api = self.create(access="private", voices=[{"name": "kv", "audio_id": self.audio}])
        upload = self.client.post("/api/audio/upload", files={"file": ("u.wav", b"upload")}).json()
        self.assertEqual(self.client.get("/tts/live/voices").status_code, 401)
        listing = self.client.get("/tts/live/voices", headers={"Authorization": f"Bearer {api['token']}"}).json()
        self.assertEqual(listing["saved"], [{"voice": "kv", "audio": "卡维/a.wav"}])
        self.assertEqual(sorted(listing["samples"]), ["_other/x.wav", "卡维/a.wav"])
        self.assertEqual(listing["uploads"], [{"voice": upload["id"], "name": "u.wav"}])

    def test_post_form_and_query(self):
        """Reader apps POST form fields or query parameters, not JSON."""
        api = self.create(access="private", voices=[{"name": "kv", "audio_id": self.audio}])
        auth = {"Authorization": f"Bearer {api['token']}"}
        response = self.client.post("/tts/live", data={"voice": "kv", "text": "a&b=\"c\""}, headers=auth)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.engine.calls[-1][1], 'a&b="c"')
        response = self.client.post("/tts/live?voice=kv&text=%E4%BD%A0%E5%A5%BD", headers=auth)
        self.assertEqual((response.status_code, self.engine.calls[-1][1]), (200, "你好"))
        self.assertEqual(self.client.post("/tts/live", data={"voice": "kv"}, headers=auth).status_code, 400)

    def test_profiles(self):
        voices = [{"name": "卡 维", "audio_id": self.audio}, {"name": "x", "audio_id": self.audio}]
        api = self.create(voices=voices)
        base = "http://192.168.1.5:7863"
        legado = self.request("GET", f"/apis/{api['id']}/profile/legado?base={base}")
        self.assertEqual([e["name"] for e in legado], ["n · 卡 维", "n · x"])
        self.assertEqual(legado[0]["url"], base + "/tts/live?voice=%E5%8D%A1%20%E7%BB%B4&text={{encodeURIComponent(speakText)}}")
        self.assertEqual(legado[1]["id"], legado[0]["id"] + 1)
        note = self.request("GET", f"/apis/{api['id']}/profile/ireadnote?base={base}/")
        handle = note["ttsHandles"][0]
        self.assertEqual((note["_ClassName"], len(note["_TTSConfigID"])), ("JxdAdvCustomTTS", 26))
        self.assertEqual((handle["url"], handle["forGetMethod"], handle["params"]), (base + "/tts/live", 1, {"voice": "@json:voiceName", "text": "%@"}))
        self.assertEqual([v["name"] for v in note["voiceList"]], ["卡 维", "x"])
        self.request("GET", f"/apis/{api['id']}/profile/legado?base=192.168.1.5", status=400)
        self.request("GET", f"/apis/{api['id']}/profile/other?base={base}", status=404)

        # Private: form POST with the token in a header, in both formats.
        fields = {"name": "n", "slug": "live", "access": "private", "voices": voices[:1]}
        token = self.request("PUT", f"/apis/{api['id']}", fields)["token"]
        entry = self.request("GET", f"/apis/{api['id']}/profile/legado?base={base}")[0]
        address, option = entry["url"].split(",", 1)
        self.assertEqual(address, base + "/tts/live")
        option = json.loads(option)
        self.assertEqual(option["method"], "POST")
        self.assertEqual(option["body"], "voice=%E5%8D%A1%20%E7%BB%B4&text={{encodeURIComponent(speakText)}}")
        self.assertEqual(option["headers"], {"Authorization": f"Bearer {token}"})
        self.assertEqual(json.loads(entry["header"]), option["headers"])
        handle = self.request("GET", f"/apis/{api['id']}/profile/ireadnote?base={base}")["ttsHandles"][0]
        self.assertEqual((handle["forGetMethod"], handle["params"]["voice"]), (0, "卡 维"))
        self.assertEqual(handle["httpConfigs"]["headers"], {"Authorization": f"Bearer {token}"})

        # 网络导入: the token may come as ?token=; addresses use the host the app reached.
        self.assertEqual(self.client.get("/tts/live/profile/legado").status_code, 401)
        imported = self.client.get(f"/tts/live/profile/legado?token={token}").json()
        self.assertTrue(imported[0]["url"].startswith("http://testserver/tts/live,"))

    def test_validation(self):
        api = self.create(enabled=False)
        self.assertEqual(self.client.get("/tts/live", params={"text": "t", "voice": self.audio}).status_code, 404)
        self.request("POST", "/apis", {"name": "m", "slug": "LIVE"}, status=400)
        voice = {"name": "kv", "audio_id": self.audio}
        self.request("PUT", f"/apis/{api['id']}", {"name": "n", "slug": "live", "voices": [voice, voice]}, status=400)
        self.request("PUT", f"/apis/{api['id']}", {"name": "n", "slug": "live", "voices": [{"name": "a/b", "audio_id": self.audio}]}, status=422)

    def test_role_rename_moves_voices(self):
        role = self.request("POST", "/roles", {"name": "卡维"})
        api = self.create(voices=[{"name": "kv", "audio_id": self.audio}])
        (self.samples / "卡维").rename(self.samples / "新卡维")
        self.request("PUT", f"/roles/{role['id']}", {"name": "新卡维"})
        voice = self.request("GET", "/apis")[0]["voices"][0]["audio_id"]
        self.assertEqual(self.request("GET", f"/audio/{voice}")["path"], "新卡维/a.wav")
        self.assertEqual(api["id"], self.request("GET", "/apis")[0]["id"])


if __name__ == "__main__":
    unittest.main()
