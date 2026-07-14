import { describe, expect, it } from "vitest";

import {
  detectUnitvDevice,
  getUnitvInstallationGuidance,
  UNITV_ANDROID_APK_URL,
  UNITV_DOWNLOADER_CODE,
  UNITV_TUTORIAL_URL,
  UNITV_TV_APK_URL
} from "@/lib/unitv/device-compatibility";

describe("UNITV device compatibility", () => {
  it.each([
    ["quero baixar na tv box", "tvbox_android"],
    ["tenho um xplus", "tvbox_android"],
    ["minha tv é android", "android_tv_google_tv"],
    ["tenho Google TV", "android_tv_google_tv"],
    ["baixar no celular", "android_phone"],
    ["tenho fire stick", "firestick"],
    ["minha tv é samsung", "samsung_tv"],
    ["minha tv é lg", "lg_tv"],
    ["minha Samsung tem Play Store", "android_tv_google_tv"],
    ["tenho iphone", "iphone"],
    ["tenho roku", "roku"],
    ["minha TV HQ", "hq_tv"],
    ["minha TV HQ tem Android TV", "android_tv_google_tv"]
  ] as const)("detects %s as %s", (message, device) => {
    expect(detectUnitvDevice(message)).toBe(device);
  });

  it("sends TV Box APK, Downloader and the mandatory tutorial", () => {
    const guidance = getUnitvInstallationGuidance("quero baixar na tv box");
    expect(guidance?.reply).toContain(UNITV_TV_APK_URL);
    expect(guidance?.reply).toContain(UNITV_DOWNLOADER_CODE);
    expect(guidance?.reply).toContain(UNITV_TUTORIAL_URL);
    expect(guidance?.reply).toContain("link ou pelo Downloader?");
    expect(guidance?.leadProfilePatch).toMatchObject({
      device: "tvbox_android",
      device_compatible: true,
      download_method_sent: "apk_tv",
      youtube_tutorial_sent: true,
      last_download_url_sent: UNITV_TV_APK_URL
    });
  });

  it.each([
    ["minha tv é android", "android_tv_google_tv", "Downloader", UNITV_DOWNLOADER_CODE],
    ["baixar no celular", "android_phone", UNITV_ANDROID_APK_URL, "Seu celular é Android?"],
    ["tenho fire stick", "firestick", "Downloader", UNITV_DOWNLOADER_CODE]
  ] as const)("sends compatible guidance for %s", (message, device, expectedOne, expectedTwo) => {
    const guidance = getUnitvInstallationGuidance(message);
    expect(guidance?.leadProfilePatch.device).toBe(device);
    expect(guidance?.leadProfilePatch.device_compatible).toBe(true);
    expect(guidance?.reply).toContain(expectedOne);
    expect(guidance?.reply).toContain(expectedTwo);
    expect(guidance?.reply).toContain(UNITV_TUTORIAL_URL);
    expect(guidance?.reply.trim().endsWith("?")).toBe(true);
  });

  it.each([
    ["minha tv é samsung", "samsung_tv", "Play Store", "TV Box Android ou Fire Stick"],
    ["minha tv é lg", "lg_tv", "Play Store", "TV Box Android ou Fire Stick"],
    ["tenho iphone", "iphone", "não tenho instalação Android", "TV Box, Android TV, Fire Stick ou celular Android"],
    ["tenho roku", "roku", "não tenho instalação compatível", "TV Box Android, Android TV, Fire Stick ou celular Android"]
  ] as const)("does not send an Android APK to %s", (message, device, expectedOne, expectedTwo) => {
    const guidance = getUnitvInstallationGuidance(message);
    expect(guidance?.leadProfilePatch.device).toBe(device);
    expect(guidance?.reply).toContain(expectedOne);
    expect(guidance?.reply).toContain(expectedTwo);
    expect(guidance?.reply).not.toContain("mediafire.com");
    expect(guidance?.reply).not.toContain(UNITV_DOWNLOADER_CODE);
  });

  it("asks for the device before sending a generic download", () => {
    const guidance = getUnitvInstallationGuidance("como baixar?");
    expect(guidance?.reply).toContain("TV Box Android, Android TV, Fire Stick ou celular Android?");
    expect(guidance?.reply).not.toContain("mediafire.com");
    expect(guidance?.reply).not.toContain(UNITV_DOWNLOADER_CODE);
    expect(guidance?.leadProfilePatch).toMatchObject({
      device: "unknown",
      device_compatible: "unknown",
      download_method_sent: "none"
    });
  });

  it("does not confirm TV HQ compatibility before checking Android", () => {
    const guidance = getUnitvInstallationGuidance("minha TV HQ funciona?");

    expect(guidance?.leadProfilePatch).toMatchObject({
      device: "hq_tv",
      device_compatible: "unknown"
    });
    expect(guidance?.reply).toContain("possui Android ou Android TV?");
    expect(guidance?.reply).not.toContain("mediafire.com");
    expect(guidance?.reply).not.toContain(UNITV_DOWNLOADER_CODE);
  });
});
