export const UNITV_TUTORIAL_URL = "https://www.youtube.com/watch?v=LBBAbs2-I0c";
export const UNITV_DOWNLOADER_CODE = "8322904";
export const UNITV_ANDROID_APK_URL = "https://www.mediafire.com/file_premium/e2jc97dcqr80tjw/UniTV_mobile_3.21.6.apk/file";
export const UNITV_TV_APK_URL = "https://www.mediafire.com/file_premium/tjgxo5756ftbx02/unitv_stb_4.19.apk/file";

export type UnitvDeviceId =
  | "tvbox_android"
  | "android_tv_google_tv"
  | "android_phone"
  | "firestick"
  | "samsung_tv"
  | "lg_tv"
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

export function isUnitvInstallationRequest(message: string) {
  const text = normalize(message);
  return detectUnitvDevice(message) !== "unknown" ||
    /\b(baixar|download|dowload|apk|instalar|instalacao|link|tutorial|downloader|tv box|tvbox|xplus|android tv|google tv|fire stick|firestick|samsung|roku|iphone|ios|celular|smart tv|play store)\b/.test(text) ||
    /\btv lg\b/.test(text) || /^lg$/.test(text);
}

export function getUnitvInstallationGuidance(message: string): UnitvInstallationGuidance | null {
  if (!isUnitvInstallationRequest(message)) {
    return null;
  }

  const text = normalize(message);
  const device = detectUnitvDevice(message);
  const config = UNITV_DEVICE_COMPATIBILITY[device];
  const basePatch = {
    device,
    aparelho: config.label,
    device_compatible: config.compatible,
    download_method_sent: "none",
    youtube_tutorial_sent: false
  };

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
      leadProfilePatch: { ...basePatch, download_method_sent: "downloader_code", youtube_tutorial_sent: true }
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
      leadProfilePatch: { ...basePatch, download_method_sent: "downloader_code", youtube_tutorial_sent: true }
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

function normalize(value: string) {
  return value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
