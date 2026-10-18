import assert from "node:assert/strict";
import { test } from "node:test";
import { isCameraCaptureUrl } from "../src/utils/media.ts";

const capturePath = "/captures/5a7cc6d8d6ad0b5c262605c7dae903ec/frame_000001.jpg";

test("camera screenshot recognition accepts absolute HTTP(S) capture frames", () => {
  for (const origin of ["http://127.0.0.1:8787", "https://camera.example.com"]) {
    assert.equal(isCameraCaptureUrl(origin + capturePath), true);
  }
  assert.equal(isCameraCaptureUrl("http://127.0.0.1:8787" + capturePath.replace("000001", "999999")), true);
});

test("camera screenshot recognition rejects unrelated images, credentials, query parameters and unsafe URLs", () => {
  const origin = "http://127.0.0.1:8787";
  for (const value of [
    capturePath,
    "//127.0.0.1:8787" + capturePath,
    origin + "/images/frame_000001.jpg",
    origin + capturePath.replace("5a7cc6d8d6ad0b5c262605c7dae903ec", "short"),
    origin + capturePath.replace("000001", "1"),
    origin + capturePath.replace(".jpg", ".png"),
    origin + capturePath + "?token=secret",
    origin + capturePath + "#fragment",
    "http://user:secret@127.0.0.1:8787" + capturePath,
    "file:///C:" + capturePath,
    "data:image/jpeg;base64,AAAA",
    "blob:" + origin + capturePath,
    origin + capturePath + "\n",
    origin + capturePath.replace("/captures/", "\\captures/"),
    "",
  ]) {
    assert.equal(isCameraCaptureUrl(value), false, value);
  }
});
