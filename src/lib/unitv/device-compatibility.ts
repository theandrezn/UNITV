export const UNITV_TUTORIAL_URL = "https://www.youtube.com/watch?v=LBBAbs2-I0c";
export const UNITV_DOWNLOADER_CODE = "862585";
export const UNITV_ANDROID_APK_URL = "https://www.mediafire.com/file_premium/e2jc97dcqr80tjw/UniTV_mobile_3.21.6.apk/file";
export const UNITV_TV_APK_URL = "https://www.mediafire.com/file_premium/tjgxo5756ftbx02/unitv_stb_4.19.apk/file";

export type UnitvDeviceId =
  | "tvbox_android"
  | "android_tv_google_tv"
  | "android_phone"
  | "firestick"
  | "samsung_tv"
  | "lg_tv"
  | "hq_tv"
  | "iphone"
  | "roku"
  | "computer"
  | "unknown";

export type UnitvDeviceCompatibility = {
  compatible: boolean | "unknown";
  label: string;
  recommended_method: string;
  download_url?: string;
  downloader_code?: string;
  youtube_tutorial?: string;
};

export type UnitvDeviceContext = {
  device_brand: string | null;
  device_type: "phone" | "tv" | "tv_box" | "streaming_stick" | "computer" | "unknown";
  operating_system: "android" | "android_tv" | "fire_os" | "ios" | "roku_os" | "windows_or_macos" | "unknown";
  has_play_store: boolean | null;
  android_confirmed: boolean | null;
  compatibility_status: "unknown" | "needs_capability_check" | "compatible" | "incompatible";
  installation_attempt_status: "not_started" | "instructions_sent" | "downloaded" | "installed" | "failed";
};

export const UNITV_DEVICE_COMPATIBILITY: Record<UnitvDeviceId, UnitvDeviceCompatibility> = {
  tvbox_android: {
    compatible: true,
    label: "TV Box Android",
    recommended_method: "apk_tv_or_downloader",
    download_url: UNITV_TV_APK_URL,
    downloader_code: UNITV_DOWNLOADER_CODE,
    youtube_tutorial: UNITV_TUTORIAL_URL
  },
  android_tv_google_tv: {
    compatible: true,
    label: "Android TV / Google TV",
    recommended_method: "downloader",
    downloader_code: UNITV_DOWNLOADER_CODE,
    youtube_tutorial: UNITV_TUTORIAL_URL
  },
  android_phone: {
    compatible: true,
    label: "Celular Android",
    recommended_method: "apk_mobile",
    download_url: UNITV_ANDROID_APK_URL,
    youtube_tutorial: UNITV_TUTORIAL_URL
  },
  firestick: {
    compatible: true,
    label: "Fire Stick",
    recommended_method: "downloader",
    downloader_code: UNITV_DOWNLOADER_CODE,
    youtube_tutorial: UNITV_TUTORIAL_URL
  },
  samsung_tv: { compatible: "unknown", label: "Samsung TV", recommended_method: "ask_android_or_playstore" },
  lg_tv: { compatible: "unknown", label: "LG TV", recommended_method: "ask_android_or_playstore" },
  hq_tv: { compatible: "unknown", label: "TV HQ", recommended_method: "ask_android_or_android_tv" },
  iphone: { compatible: false, label: "iPhone / iOS", recommended_method: "suggest_android_device" },
  roku: { compatible: false, label: "Roku", recommended_method: "suggest_android_device" },
  computer: { compatible: false, label: "Computador", recommended_method: "suggest_android_device" },
  unknown: { compatible: "unknown", label: "Aparelho desconhecido", recommended_method: "ask_device" }
};

export type UnitvInstallationGuidance = {
  reply: string;
  leadProfilePatch: Record<string, unknown>;
};

export function detectUnitvDevice(message: string): UnitvDeviceId {
  const text = normalize(message);
  if (/\b(iphone|ios|apple)\b/.test(text)) return "iphone";
  if (/\broku\b/.test(text)) return "roku";
  if (/\b(samsung|lg)\b/.test(text) && /\b(android|play store)\b/.test(text)) return "android_tv_google_tv";
  if (/\b(tv hq|hq tv|televisao hq|smart tv hq)\b/.test(text) && /\b(android|android tv|google tv)\b/.test(text)) return "android_tv_google_tv";
  if (/\b(tv hq|hq tv|televisao hq|smart tv hq)\b/.test(text)) return "hq_tv";
  if (/\b(samsung|tv samsung)\b/.test(text)) return "samsung_tv";
  if (/\b(lg|tv lg)\b/.test(text)) return "lg_tv";
  if (/\b(fire stick|firestick|fire tv|amazon fire)\b/.test(text)) return "firestick";
  if (/\b(tv box|tvbox|box|xplus|aparelho android|receptor android)\b/.test(text)) return "tvbox_android";
  if (
    /\b(android tv|google tv|tv android|televisao android|play store na tv)\b/.test(text) ||
    /\b(tv|televisao)\b.{0,24}\b(android|play store)\b/.test(text) ||
    /\bplay store\b.{0,24}\b(tv|televisao)\b/.test(text)
  ) return "android_tv_google_tv";
  if (/\b(celular|telefone|apk mobile|baixar no celular)\b/.test(text) || /^android$/.test(text)) return "android_phone";
  if (/\b(computador|notebook|windows|macbook|macos|pc)\b/.test(text)) return "computer";
  if (/\bdownloader\b/.test(text)) return "android_tv_google_tv";
  return "unknown";
}

export function resolveUnitvDeviceContext(message: string): UnitvDeviceContext {
  const text = normalize(message);
  const device = detectUnitvDevice(message);
  const explicitlyAndroid = /\b(android|android tv|google tv)\b/.test(text);
  const explicitlyNoAndroid = /\b(sem android|nao tem android|nao possui android)\b/.test(text);
  const hasPlayStore = /\b(tem|possui|com) play store\b|\bplay store\b.*\b(tem|possui|sim)\b/.test(text)
    ? true
    : /\b(sem|nao tem|nao possui) play store\b/.test(text)
      ? false
      : null;
  const config = UNITV_DEVICE_COMPATIBILITY[device];
  const capabilityCompatible = explicitlyAndroid || hasPlayStore === true;
  const explicitlyIncompatible = explicitlyNoAndroid || hasPlayStore === false || config.compatible === false ||
    ((device === "lg_tv" || device === "samsung_tv") && /\b(antiga|velha)\b/.test(text));
  const compatibilityStatus = explicitlyIncompatible
    ? "incompatible"
    : config.compatible === true || capabilityCompatible
      ? "compatible"
      : config.compatible === "unknown"
        ? "needs_capability_check"
        : "unknown";
  return {
    device_brand: detectBrand(device, text),
    device_type: detectDeviceType(device),
    operating_system: detectOperatingSystem(device, explicitlyAndroid),
    has_play_store: hasPlayStore,
    android_confirmed: explicitlyIncompatible ? false : explicitlyAndroid || device === "tvbox_android" || device === "android_tv_google_tv" || device === "android_phone" ? true : null,
    compatibility_status: compatibilityStatus,
    installation_attempt_status: /\b(nao deu|nao consegui|falhou|erro)\b/.test(text) ? "failed" : "not_started"
  };
}

export function isUnitvInstallationRequest(message: string) {
  const text = normalize(message);
  return detectUnitvDevice(message) !== "unknown" ||
    /\b(baixar|download|dowload|apk|instalar|instalacao|link|tutorial|downloader|tv box|tvbox|xplus|android tv|google tv|fire stick|firestick|samsung|roku|iphone|ios|celular|smart tv|play store|tv hq|hq tv|televisao hq)\b/.test(text) ||
    /\btv lg\b/.test(text) || /^lg$/.test(text);
}

export function getUnitvInstallationGuidance(message: string): UnitvInstallationGuidance | null {
  if (!isUnitvInstallationRequest(message)) {
    return null;
  }

  const text = normalize(message);
  const device = detectUnitvDevice(message);
  const config = UNITV_DEVICE_COMPATIBILITY[device];
  const deviceContext = resolveUnitvDeviceContext(message);
  const basePatch = {
    device,
    aparelho: config.label,
    device_compatible: deviceContext.compatibility_status === "compatible"
      ? true
      : deviceContext.compatibility_status === "incompatible"
        ? false
        : "unknown",
    ...deviceContext,
    download_method_sent: "none",
    youtube_tutorial_sent: false
  };

  if (
    device === "lg_tv" &&
    (/\b(lg|tv lg)\b.{0,24}\b(antiga|velha|sem android|nao tem android|sem play store|nao tem play store)\b/.test(text) ||
      /\b(antiga|velha|sem android|nao tem android|sem play store|nao tem play store)\b.{0,24}\b(lg|tv lg)\b/.test(text))
  ) {
    return {
      reply: "",
      leadProfilePatch: {
        ...basePatch,
        device_compatible: false,
        commercial_stage: "incompatible_device",
        stage: "incompatible_device",
        state: "closed_incompatible_device",
        install_status: "failed",
        download_status: "failed",
        compatibility_status: "incompatible",
        installation_attempt_status: "failed",
        next_expected_reply: null
      }
    };
  }

  if (/\b(video|tutorial)\b/.test(text) && device === "unknown") {
    return {
      reply: `Tutorial de instalação UNITV:\n\n${UNITV_TUTORIAL_URL}\n\nVocê vai instalar em TV Box Android, Android TV, Fire Stick ou celular Android?`,
      leadProfilePatch: { ...basePatch, youtube_tutorial_sent: true }
    };
  }

  if (device === "tvbox_android") {
    return {
      reply:
        `Na TV Box Android funciona sim.\n\nVocê pode instalar pelo APK de TV Box:\n\n${UNITV_TV_APK_URL}\n\n` +
        `Ou pelo Downloader usando o código:\n\n${UNITV_DOWNLOADER_CODE}\n\nTutorial:\n${UNITV_TUTORIAL_URL}\n\n` +
        "Você prefere instalar pelo link ou pelo Downloader?",
      leadProfilePatch: {
        ...basePatch,
        download_method_sent: "apk_tv",
        installation_attempt_status: "instructions_sent",
        youtube_tutorial_sent: true,
        last_download_url_sent: UNITV_TV_APK_URL
      }
    };
  }

  if (device === "android_tv_google_tv") {
    return {
      reply:
        `Na Android TV ou Google TV funciona sim.\n\nO caminho mais simples é pelo Downloader.\n\n` +
        `Instale o Downloader by AFTVnews na Play Store da TV e digite o código:\n\n${UNITV_DOWNLOADER_CODE}\n\n` +
        `Tutorial:\n${UNITV_TUTORIAL_URL}\n\nConseguiu encontrar o Downloader na Play Store?`,
      leadProfilePatch: { ...basePatch, download_method_sent: "downloader_code", youtube_tutorial_sent: true, installation_attempt_status: "instructions_sent" }
    };
  }

  if (device === "android_phone") {
    return {
      reply:
        `No celular Android funciona sim.\n\nBaixe por aqui:\n\n${UNITV_ANDROID_APK_URL}\n\n` +
        `Tutorial:\n${UNITV_TUTORIAL_URL}\n\nSeu celular é Android?`,
      leadProfilePatch: {
        ...basePatch,
        download_method_sent: "apk_mobile",
        installation_attempt_status: "instructions_sent",
        youtube_tutorial_sent: true,
        last_download_url_sent: UNITV_ANDROID_APK_URL
      }
    };
  }

  if (device === "firestick") {
    return {
      reply:
        `No Fire Stick dá para instalar pelo Downloader.\n\nAbra o Downloader e use o código:\n\n${UNITV_DOWNLOADER_CODE}\n\n` +
        `Tutorial:\n${UNITV_TUTORIAL_URL}\n\nVocê já tem o Downloader instalado no Fire Stick?`,
      leadProfilePatch: { ...basePatch, download_method_sent: "downloader_code", youtube_tutorial_sent: true, installation_attempt_status: "instructions_sent" }
    };
  }

  if (device === "samsung_tv" || device === "lg_tv") {
    const brand = device === "samsung_tv" ? "Samsung" : "LG";
    return {
      reply:
        `${brand} normalmente não usa Android.\n\nMe confirma se sua TV ${brand} tem Play Store ou sistema Android?\n\n` +
        "Se não tiver, o ideal é usar uma TV Box Android ou Fire Stick para instalar a UNITV.",
      leadProfilePatch: basePatch
    };
  }

  if (device === "hq_tv") {
    return {
      reply:
        "Na TV HQ eu preciso confirmar o sistema antes. Ela possui Android ou Android TV?\n\n" +
        "Se nao possuir, nao vou confirmar compatibilidade sem verificar outro aparelho compativel.",
      leadProfilePatch: basePatch
    };
  }

  if (device === "iphone") {
    return {
      reply:
        "No iPhone eu não tenho instalação Android para enviar.\n\n" +
        "Você teria uma TV Box, Android TV, Fire Stick ou celular Android para usar?",
      leadProfilePatch: basePatch
    };
  }

  if (device === "roku" || device === "computer") {
    const label = device === "roku" ? "Roku" : "computador";
    return {
      reply:
        `No ${label} não tenho instalação compatível para enviar.\n\n` +
        "O ideal é usar TV Box Android, Android TV, Fire Stick ou celular Android.\n\nVocê tem algum desses aparelhos?",
      leadProfilePatch: basePatch
    };
  }

  return {
    reply: "Eu te mando o caminho certo.\n\nVocê vai instalar em TV Box Android, Android TV, Fire Stick ou celular Android?",
    leadProfilePatch: basePatch
  };
}

function detectBrand(device: UnitvDeviceId, text: string) {
  if (/\bsamsung\b/.test(text)) return "samsung";
  if (/\blg\b/.test(text)) return "lg";
  if (/\b(tv hq|hq tv|televisao hq|smart tv hq)\b/.test(text)) return "hq";
  if (device === "lg_tv") return "lg";
  if (device === "samsung_tv") return "samsung";
  if (device === "hq_tv") return "hq";
  if (device === "firestick") return "amazon";
  if (device === "iphone") return "apple";
  if (device === "roku") return "roku";
  return null;
}

function detectDeviceType(device: UnitvDeviceId): UnitvDeviceContext["device_type"] {
  if (device === "android_phone" || device === "iphone") return "phone";
  if (["android_tv_google_tv", "samsung_tv", "lg_tv", "hq_tv", "roku"].includes(device)) return "tv";
  if (device === "tvbox_android") return "tv_box";
  if (device === "firestick") return "streaming_stick";
  if (device === "computer") return "computer";
  return "unknown";
}

function detectOperatingSystem(device: UnitvDeviceId, explicitlyAndroid: boolean): UnitvDeviceContext["operating_system"] {
  if (device === "android_phone") return "android";
  if (device === "android_tv_google_tv" || device === "tvbox_android" || explicitlyAndroid) return "android_tv";
  if (device === "firestick") return "fire_os";
  if (device === "iphone") return "ios";
  if (device === "roku") return "roku_os";
  if (device === "computer") return "windows_or_macos";
  return "unknown";
}

function normalize(value: string) {
  return value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
