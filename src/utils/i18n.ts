import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import en_US from "@/locales/en-US.json";
import ja_JP from "@/locales/ja-JP.json";
import zh_CN from "@/locales/zh-CN.json";
import zh_TW from "@/locales/zh-TW.json";

const resources = {
	"zh-CN": {
		translation: zh_CN,
	},
	"zh-TW": {
		translation: zh_TW,
	},
	"en-US": {
		translation: en_US,
	},
	"ja-JP": {
		translation: ja_JP,
	},
};

i18n
	// 检测用户语言
	.use(LanguageDetector)
	// 将i18n实例传递给react-i18next
	.use(initReactI18next)
	// 初始化i18next
	.init({
		resources,
		fallbackLng: "zh-CN", // 默认语言
		interpolation: {
			escapeValue: false, // 不转义特殊字符
		},
		detection: {
			order: ["localStorage", "navigator"],
			caches: ["localStorage"],
		},
	});

export default i18n;
