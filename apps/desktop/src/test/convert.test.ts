import { describe, expect, it } from "vitest";
import { convertInfoUrl, convertSrc, firstStage } from "../player/convert";

describe("converter", () => {
  const yes = () => true;
  const no = () => false;
  it("keeps an H.264 picture and converts the rest", () => {
    expect(firstStage("avc1.64001f", no)).toBe(1);
    expect(firstStage(null, no)).toBe(1);
  });
  it("converts HEVC only where the webview can't show it", () => {
    expect(firstStage("hvc1.1.6.L120.90", yes)).toBe(1);
    expect(firstStage("hev1.1.6.L93.B0", no)).toBe(2);
  });
  it("converts other pictures straight away", () => {
    expect(firstStage("mp4v.20.9", yes)).toBe(2);
  });
  it("builds the converter's addresses", () => {
    const base = "http://127.0.0.1:4000/s/abc/c/stream.ts";
    expect(convertSrc(base, 1)).toBe(`${base}?v=copy`);
    expect(convertSrc(base, 2, 95.25)).toBe(`${base}?v=h264&t=95.3`);
    expect(convertInfoUrl(base)).toBe("http://127.0.0.1:4000/s/abc/c/info");
  });
});
