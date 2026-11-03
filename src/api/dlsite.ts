/**
 * DLsite 手动单源查询。
 * 不保存 Cookie，不参与 Mixed；请求仅由添加游戏窗口主动发起。
 */

import type { DlsiteData, GameCandidateData } from "@/types";
import { invoke } from "@tauri-apps/api/core";
import { AppError, isHttpStatus, toError } from "@/utils/errors";
import http, { USER_AGENT } from "./http";

const DLSITE_BASE = "https://www.dlsite.com";
const DLSITE_REQUEST_INTERVAL_MS = 600;
const dlsiteIdRegex = /\b(?:RJ|RE|VJ)\d{4,}\b/i;

interface DlsiteProductInfo {
	work_name?: string;
	product_name?: string;
	name?: string;
	work_image?: string;
	circle?: string;
	brand?: string;
	maker_name?: string;
	publisher?: string;
	description?: string;
	regist_date?: string;
	age_category?: number | string;
	genre?: string[];
}

type DlsiteProductInfoResponse = Record<string, DlsiteProductInfo>;

interface DlsiteSearchItem {
	id: string;
	name: string;
	image?: string;
	developer?: string;
}

let queuedRequest = Promise.resolve();
let lastRequestAt = 0;

function normalizeText(value: string | null | undefined): string {
	return (value ?? "").trim().replace(/\s+/g, " ");
}

export function normalizeDlsiteId(value: string): string | undefined {
	return value.trim().match(dlsiteIdRegex)?.[0]?.toUpperCase();
}

function createDlsiteHeaders(locale = "ja") {
	return {
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"Accept-Language": "ja,en;q=0.8",
		Cookie: `adultchecked=1; locale=${locale}`,
		"User-Agent": USER_AGENT,
	};
}

function getDlsiteSection(id: string): "maniax" | "pro" {
	return id.startsWith("VJ") ? "pro" : "maniax";
}

function getWorkUrl(id: string): string {
	return `${DLSITE_BASE}/${getDlsiteSection(id)}/work/=/product_id/${id}.html?locale=ja`;
}

function getSearchUrl(name: string, locale: string): string {
	const encoded = encodeURIComponent(name).replace(/%20/g, "+");
	return `${DLSITE_BASE}/maniax/fsr/=/language/jp/keyword/${encoded}/?locale=${locale}`;
}

function normalizeUrl(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.startsWith("data:")) return undefined;
	if (trimmed.startsWith("//")) return `https:${trimmed}`;
	if (trimmed.startsWith("/")) return `${DLSITE_BASE}${trimmed}`;
	return trimmed;
}

function normalizeListImage(value: string | null | undefined): string | undefined {
	return normalizeUrl(value)
		?.replace("/resize/", "/modpub/")
		.replace(/main_240x240\.jpg$/, "main.webp");
}

function firstSrcSetUrl(value: string | null): string | undefined {
	return normalizeUrl(value?.split(",")[0]?.trim().split(/\s+/)[0]);
}

function getImageCandidates(element: Element): string[] {
	return [
		normalizeUrl(element.getAttribute("data-src")),
		firstSrcSetUrl(element.getAttribute("srcset")),
		normalizeUrl(element.getAttribute("src")),
	]
		.filter((value): value is string => Boolean(value));
}

function extractImageUrlFromText(value: string | null): string | undefined {
	const match = value?.match(
		/(?:https?:)?\/\/[^'"\s]+\.(?:webp|jpe?g|png)(?:\?[^'"\s]*)?/i,
	);
	return normalizeListImage(match?.[0]);
}

function extractListThumbnail(root: ParentNode): string | undefined {
	for (const element of root.querySelectorAll("*")) {
		const image =
			extractImageUrlFromText(element.getAttribute("thumb-candidates")) ??
			extractImageUrlFromText(element.getAttribute(":thumb-candidates"));
		if (image) return image;
	}

	for (const image of root.querySelectorAll("img")) {
		const candidate =
			normalizeListImage(image.getAttribute("data-src")) ??
			normalizeListImage(image.getAttribute("src")) ??
			extractImageUrlFromText(image.getAttribute(":src"));
		if (candidate) return candidate;
	}

	return undefined;
}

function extractMainWorkImage(root: ParentNode): string | undefined {
	let fallback: string | undefined;
	for (const element of root.querySelectorAll("img, source")) {
		for (const candidate of getImageCandidates(element)) {
			if (!fallback && candidate.includes("_img_smp")) {
				fallback = candidate;
			}
			if (candidate.includes("_img_main")) return candidate;
		}
	}
	return fallback;
}

function waitForDlsiteTurn(): Promise<void> {
	let release: () => void;
	const previousRequest = queuedRequest;
	queuedRequest = new Promise<void>((resolve) => {
		release = resolve;
	});

	return previousRequest
		.then(async () => {
			const waitMs = Math.max(
				0,
				lastRequestAt + DLSITE_REQUEST_INTERVAL_MS - Date.now(),
			);
			if (waitMs > 0) {
				await new Promise<void>((resolve) => window.setTimeout(resolve, waitMs));
			}
			lastRequestAt = Date.now();
		})
		.finally(() => release());
}

async function fetchDlsiteText(url: string, locale = "ja"): Promise<string> {
	await waitForDlsiteTurn();
	try {
		return (
			await http.getText(url, {
				headers: createDlsiteHeaders(locale),
				proxyUrl: await getWindowsSystemProxy(),
			})
		).data;
	} catch (error) {
		if (isHttpStatus(error, 429)) {
			throw new AppError({
				code: "metadata_request_failed",
				message: "DLsite 暂时限制访问，请稍后再试",
				cause: error,
			});
		}
		throw error;
	}
}

async function fetchDlsiteProductInfo(
	id: string,
): Promise<DlsiteProductInfo | undefined> {
	await waitForDlsiteTurn();
	const response = await http.get<DlsiteProductInfoResponse>(
		`${DLSITE_BASE}/maniax/product/info/ajax`,
		{
			params: { product_id: id, locale: "ja" },
			headers: { ...createDlsiteHeaders(), Accept: "application/json" },
			proxyUrl: await getWindowsSystemProxy(),
		},
	);
	return response.data?.[id];
}

async function getWindowsSystemProxy(): Promise<string | undefined> {
	try {
		return (await invoke<string | null>("get_windows_system_proxy")) ?? undefined;
	} catch {
		return undefined;
	}
}

function parseDocument(html: string): Document {
	return new DOMParser().parseFromString(html, "text/html");
}

function parseSearchDocument(document: Document): DlsiteSearchItem[] {
	const seen = new Set<string>();
	const results: DlsiteSearchItem[] = [];
	const roots = document.querySelectorAll(
		".search_result_img_box_inner, [data-list_item_product_id]",
	);

	for (const node of roots) {
		const root = node.closest(".search_result_img_box_inner") ?? node;
		const id = normalizeDlsiteId(
			root.getAttribute("data-list_item_product_id") ??
				root.querySelector("a[href*='product_id']")?.getAttribute("href") ??
				"",
		);
		const nameLink =
			root.querySelector(".work_name a") ??
			root.querySelector("[itemprop='name']") ??
			root.querySelector("a[href*='product_id']");
		const name = normalizeText(
			nameLink?.getAttribute("title") ?? nameLink?.textContent,
		);
		if (!id || !name || seen.has(id)) continue;

		seen.add(id);
		results.push({
			id,
			name,
			image: extractListThumbnail(root),
			developer:
				normalizeText(root.querySelector(".maker_name a")?.textContent) ||
				undefined,
		});
	}

	return results;
}

function findInfoText(
	document: Document | undefined,
	labels: readonly string[],
): string {
	for (const header of document?.querySelectorAll("th") ?? []) {
		if (labels.some((label) => normalizeText(header.textContent).includes(label))) {
			return normalizeText(header.nextElementSibling?.textContent);
		}
	}
	return "";
}

function normalizeDate(value: string | undefined): string | undefined {
	const match = normalizeText(value).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
	if (!match) return normalizeText(value) || undefined;
	return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function buildCandidate(id: string, data: DlsiteData): GameCandidateData {
	return {
		id_type: "dlsite",
		dlsite_id: id,
		dlsite_data: data,
		date: data.date,
	};
}

function buildDetailCandidate(
	id: string,
	info: DlsiteProductInfo | undefined,
	document: Document | undefined,
): GameCandidateData {
	const name =
		normalizeText(document?.querySelector("#work_name")?.textContent) ||
		normalizeText(info?.work_name) ||
		normalizeText(info?.product_name) ||
		normalizeText(info?.name);
	if (!name) {
		throw new AppError({
			code: "metadata_not_found",
			message: `DLsite entry not found: ${id}`,
		});
	}

	const ageText = findInfoText(document, ["年齢指定", "対象年齢"]);
	const isAdult = ageText
		? !(ageText.includes("全年齢") || ageText.includes("一般"))
		: info?.age_category === 3 || info?.age_category === "3";
	const tags = Array.from(
		new Set([
			...(info?.genre ?? []),
			...Array.from(document?.querySelectorAll(".main_genre a") ?? []).map(
				(tag) => normalizeText(tag.textContent),
			),
		].filter(Boolean)),
	);
	return buildCandidate(id, {
		image:
			(document ? extractMainWorkImage(document) : undefined) ??
			normalizeUrl(info?.work_image),
		name,
		summary:
			normalizeText(
				document?.querySelector('[itemprop="description"]')?.textContent,
			) || normalizeText(info?.description) || undefined,
		tags,
		developer:
			normalizeText(document?.querySelector(".maker_name a")?.textContent) ||
			normalizeText(info?.circle) ||
			normalizeText(info?.brand) ||
			normalizeText(info?.maker_name) ||
			normalizeText(info?.publisher) ||
			undefined,
		nsfw: isAdult,
		date: normalizeDate(
			findInfoText(document, ["販売日", "発売日"]) ||
				info?.regist_date,
		),
	});
}

export async function fetchDlsiteByName(
	name: string,
	limit = 8,
): Promise<GameCandidateData[]> {
	const keyword = name.trim().normalize("NFKC");
	if (!keyword) return [];
	for (const locale of ["ja", "zh_CN"]) {
		const document = parseDocument(
			await fetchDlsiteText(getSearchUrl(keyword, locale), locale),
		);
		const results = parseSearchDocument(document);
		if (results.length > 0) {
			return results.slice(0, limit).map((result) =>
				buildCandidate(result.id, {
					image: result.image,
					name: result.name,
					developer: result.developer,
				}),
			);
		}
	}
	return [];
}

export async function fetchDlsiteById(id: string): Promise<GameCandidateData> {
	const normalizedId = normalizeDlsiteId(id);
	if (!normalizedId) {
		throw new AppError({ code: "invalid_game_id", message: `Invalid DLsite id: ${id}` });
	}

	let info: DlsiteProductInfo | undefined;
	let infoError: unknown;
	try {
		info = await fetchDlsiteProductInfo(normalizedId);
	} catch (error) {
		infoError = error;
	}

	try {
		const document = parseDocument(await fetchDlsiteText(getWorkUrl(normalizedId)));
		return buildDetailCandidate(normalizedId, info, document);
	} catch (error) {
		if (info) return buildDetailCandidate(normalizedId, info, undefined);
		throw toError(infoError ?? error, "DLsite request failed");
	}
}
