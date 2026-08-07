// 2G-R6 — Comando local reutilizable del harness diagnóstico DT (SKU-first autenticado).
//   npm run diag:dt-sku-harness -- --fast|--paused|--zero-replay|--candidate|--all [--scale=N] [--delay=MS]
// READ-ONLY: cero writes de DB/Provider/Job/Woo. Un solo browser, red serial. Output en
// tmp/dt-harness/<RUN_ID>/ (no tracked). Nunca imprime/persiste precios/cookies/tokens/password.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { ScraperService } from "../lib/scraper/scraper.service";
import { buildProviderRuntimeConfig } from "../lib/scraper/provider-runtime-config";
import { prepareSkuFirstStartSnapshot } from "../lib/scraper/sku-first-start";
import { runArm, zeroReplay, sessionCheckpoint, type LsReader, type ArmResult } from "../lib/diag/dt-harness";
import { computeVerdict, type DtArmAgg, type DtZeroReplayAgg } from "../lib/diag/dt-verdict";

// Overridables por entorno (herramienta local; el repo es PÚBLICO → sin rutas personales default).
const DT_ID = process.env.DT_HARNESS_PROVIDER_ID || "cms8554bw0002cxz7qm3buvwm";
const PENV = process.env.DT_HARNESS_ENV_FILE; // requerido: ruta al .env con DIRECT_URL + ENCRYPTION_KEY
if (!PENV) { console.error("Falta DT_HARNESS_ENV_FILE (ruta al .env con DIRECT_URL y ENCRYPTION_KEY)."); process.exit(2); }
const SKU_FIRST_MODE = "TIENDANUBE_LS_VARIANTS_SKU_FIRST";

function loadEnv(p: string) {
  const o: Record<string, string> = {};
  for (const l of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return o;
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const absUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);
function writeJson(dir: string, name: string, obj: unknown): string {
  const body = JSON.stringify(obj, null, 2);
  writeFileSync(resolve(dir, name), body);
  const h = sha256(body);
  console.log(`  wrote ${name} sha256=${h}`);
  return h;
}
const flag = (n: string) => process.argv.includes(`--${n}`);
const opt = (n: string, d: number) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? Number(a.split("=")[1]) : d; };

async function main() {
  const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const OUT = resolve(process.cwd(), "tmp", "dt-harness", RUN_ID);
  mkdirSync(OUT, { recursive: true });
  console.log(`RUN_ID=${RUN_ID}\nOUT=${OUT}`);

  const doFast = flag("fast") || flag("all");
  const doPaused = flag("paused") || flag("all");
  const doZero = flag("zero-replay") || flag("all");
  const doCandidate = flag("candidate");
  const SCALE = opt("scale", 40);
  const PAUSED_DELAY = opt("delay", 400); // §13: comprobar el probe lento previo (~400ms) antes de usar

  const env = loadEnv(PENV!);
  const prisma = new PrismaClient({ datasources: { db: { url: env.DIRECT_URL } } });
  const scraper = new ScraperService();
  let exitCode = 0;
  const prevKey = process.env.ENCRYPTION_KEY;
  try {
    // ── Provider + config (READ-ONLY) ──
    const provider = await prisma.provider.findUnique({ where: { id: DT_ID }, include: { scraperConfig: true } });
    if (!provider) throw new Error("DT provider not found");
    const rc = buildProviderRuntimeConfig({ provider: { baseUrl: provider.baseUrl }, scraperConfig: provider.scraperConfig });
    const storedCredsLoaded = !!provider.encryptedPassword;
    console.log(`STORED_CREDENTIALS_LOADED=${storedCredsLoaded}`);
    console.log(`PROVIDER_REQUIRES_LOGIN=${provider.requiresLogin} EFFECTIVE_MODE=${rc.effectiveExtractionMode}`);
    if (env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = env.ENCRYPTION_KEY;

    // ── Cohorte determinística desde el START_SET (877) ──
    const sitemapFetchFn = async (url: string) => {
      const res = await fetch(url, { redirect: "manual" });
      return { status: res.status, text: await res.text(), finalUrl: res.url, header: (n: string) => res.headers.get(n) };
    };
    const startSnap = await prepareSkuFirstStartSnapshot({ extractionMode: SKU_FIRST_MODE, sitemapFetchFn });
    if (!startSnap || startSnap.kind !== "POPULATED") throw new Error(`START snapshot not populated: ${startSnap?.kind}`);
    const all877 = startSnap.urls.map(absUrl);
    // selección por hash (determinística, sin Math.random), reordenada al orden del sitemap (walk order).
    const ranked = all877.map((u, idx) => ({ u, idx, h: sha256(u) })).sort((a, b) => (a.h < b.h ? -1 : 1));
    const pickedIdx = new Set(ranked.slice(0, SCALE).map((r) => r.idx));
    const cohort = all877.map((u, idx) => ({ canonicalUrl: u, historicalOrdinal: null as number | null, idx }))
      .filter((r) => pickedIdx.has(r.idx))
      .sort((a, b) => a.idx - b.idx); // preserva orden relativo del sitemap
    const sampleObj = { size: cohort.length, source: all877.length, order: "SITEMAP_ORDER", selection: "SHA256_RANK", urls: cohort.map((c) => c.canonicalUrl) };
    const SAMPLE_SHA = writeJson(OUT, "sample.json", sampleObj);
    console.log(`SAMPLE_SIZE=${cohort.length} START_SET=${all877.length} SAMPLE_SHA256=${SAMPLE_SHA}`);
    const probeUrl = cohort[0].canonicalUrl;
    const HIGH_FAILURE_PROD_MS_PER_PRODUCT = 240; // baseline RUN_A/RUN_B (fase B, ~246/234)
    const fidelity = (mean: number) => { const r = mean / HIGH_FAILURE_PROD_MS_PER_PRODUCT; const cls = r >= 0.85 && r <= 1.15 ? "HIGH" : r > 1.3 ? "FAILED_TOO_SLOW" : r < 0.7 ? "FAILED_TOO_FAST" : "AMBIGUOUS"; return { ratio: r.toFixed(2), cls }; };

    // ── Contexto autenticado FRESCO por brazo (§13/§14): cada brazo cierra el anterior,
    //    re-inicia el browser y re-loguea. Serial, nunca dos browsers concurrentes. ──
    const onLog = async (_l: string, _m: string) => {};
    const openCtx = async (label: string): Promise<{ page: import("playwright").Page; reader: LsReader; reLogin: () => Promise<void>; authEstablished: boolean; decryptOk: boolean }> => {
      await scraper.close().catch(() => {});
      await scraper.init();
      const page = (scraper as any).page as import("playwright").Page;
      const reader: LsReader = { capture: () => (scraper as any).captureLsPayload(page) };
      const reLogin = async () => { await scraper.performLogin(page, provider as any, provider.scraperConfig, onLog as any, rc.effectiveLoginUrl); };
      await page.goto(provider.baseUrl, { waitUntil: "domcontentloaded" });
      let decryptOk = false;
      if (provider.requiresLogin && provider.encryptedPassword) {
        try { await reLogin(); decryptOk = true; }
        catch (e) { console.log(`[${label}] LOGIN_THREW=${(e as Error).message.slice(0, 60)}`); }
      }
      // Checkpoint de sesión PRE-brazo (navega el probe; fuera del loop de cadencia).
      const authEstablished = await sessionCheckpoint(page, reader, probeUrl, provider.baseUrl);
      console.log(`[${label}] CREDENTIAL_DECRYPT_SUCCEEDED=${decryptOk} AUTH_ESTABLISHED=${authEstablished}`);
      return { page, reader, reLogin, authEstablished, decryptOk };
    };

    const toDtAgg = (a: ArmResult["agg"]): DtArmAgg => ({ ...a });
    let fast: ArmResult | null = null, paused: ArmResult | null = null;
    let zeroAgg: DtZeroReplayAgg | null = null;
    let fastAuthEstablished = false;

    // ── FAST (baseline exacto del worker: captureProductRows, delay 0) — contexto fresco ──
    if (doFast || doCandidate) {
      console.log(`\n=== FAST arm (scale=${cohort.length}, delay=0, productive captureProductRows) ===`);
      const ctx = await openCtx("FAST");
      fastAuthEstablished = ctx.authEstablished;
      fast = await runArm(ctx.page, ctx.reader, ctx.reLogin, cohort, { interProductDelayMs: 0, baseUrl: provider.baseUrl,
        onProgress: (i, r) => { if (i % 25 === 0 || r.initialVariantCount === 0 || r.errorClass) console.log(`  #${i} zero=${r.errorClass === null && r.initialVariantCount === 0} variants=${r.initialVariantCount} price=${r.validPriceVariantCount} nav=${r.navStatus} err=${r.errorClass ?? "-"} ${r.elapsedMs}ms`); } });
      const sessFinal = await sessionCheckpoint(ctx.page, ctx.reader, probeUrl, provider.baseUrl);
      const fid = fidelity(fast.cadence.meanMsPerProduct);
      writeJson(OUT, "fast.json", { authEstablished: ctx.authEstablished, sessionFinalOk: sessFinal, cadence: fast.cadence, cadenceFidelity: fid, agg: fast.agg, records: fast.records });
      console.log(`FAST initialZero=${fast.agg.initialZeroVariantCount}/${fast.agg.urlCount} variantTotal=${fast.agg.variantTotal} validPrice=${fast.agg.validPriceVariantCount} sessLoss=${fast.agg.sessionLossCount} 429=${fast.agg.http429Count} reset=${fast.agg.connectionResetCount} firstZeroOrd=${fast.agg.firstZeroOrdinal}`);
      console.log(`FAST cadence mean=${fast.cadence.meanMsPerProduct.toFixed(0)}ms median=${fast.cadence.medianMsPerProduct}ms wall=${fast.cadence.wallClockMs}ms → FIDELITY ratio=${fid.ratio} ${fid.cls} (baseline ${HIGH_FAILURE_PROD_MS_PER_PRODUCT}ms)  sessionFinalOk=${sessFinal}`);
    }

    // ── ZERO-REPLAY (control puro de timing) sobre el zero-set de FAST — contexto FRESCO ──
    if (doZero && fast) {
      const zeroUrls = fast.records.filter((r) => r.errorClass === null && r.initialVariantCount === 0).map((r) => r.canonicalUrl);
      if (zeroUrls.length > 0) {
        console.log(`\n=== ZERO-REPLAY (${zeroUrls.length} zero URLs, fresh ctx, timed re-read no reload) ===`);
        const ctx = await openCtx("ZERO-REPLAY");
        const zr = await zeroReplay(ctx.page, ctx.reader, zeroUrls, provider.baseUrl);
        writeJson(OUT, "zero-replay.json", { authEstablished: ctx.authEstablished, ...zr });
        zeroAgg = zr.agg;
        console.log(`ZERO-REPLAY recovered=${zr.agg.recoveredWithoutReloadCount}/${zr.agg.urlCount} never=${zr.agg.neverRecoveredCount} maxRecoveryMs=${zr.agg.maxRecoveryMs} dist=${JSON.stringify(zr.agg.recoveryDistribution)}`);
      } else {
        console.log("\n=== ZERO-REPLAY skipped: FAST produced no zero-variant URLs ===");
      }
    }

    // ── PAUSED (control de cadencia) — sólo si FAST reprodujo ≥1 fallo — contexto FRESCO ──
    if (doPaused && fast && fast.agg.initialZeroVariantCount > 0) {
      console.log(`\n=== PAUSED arm (scale=${cohort.length}, delay=${PAUSED_DELAY}ms, fresh ctx) ===`);
      const ctx = await openCtx("PAUSED");
      paused = await runArm(ctx.page, ctx.reader, ctx.reLogin, cohort, { interProductDelayMs: PAUSED_DELAY, baseUrl: provider.baseUrl });
      const sessFinal = await sessionCheckpoint(ctx.page, ctx.reader, probeUrl, provider.baseUrl);
      writeJson(OUT, "paused.json", { delayMs: PAUSED_DELAY, authEstablished: ctx.authEstablished, sessionFinalOk: sessFinal, cadence: paused.cadence, agg: paused.agg, records: paused.records });
      console.log(`PAUSED initialZero=${paused.agg.initialZeroVariantCount}/${paused.agg.urlCount} variantTotal=${paused.agg.variantTotal} validPrice=${paused.agg.validPriceVariantCount} sessLoss=${paused.agg.sessionLossCount} cadence mean=${paused.cadence.meanMsPerProduct.toFixed(0)}ms`);
    } else if (doPaused && fast) {
      console.log("\n=== PAUSED skipped: FAST reprodujo 0 fallos (no hay fenómeno que controlar) ===");
    }

    // ── Verdict ──
    if (fast) {
      const verdict = computeVerdict({
        historical: { distribution: "EVENLY_SPREAD", firstFailureApproxOrdinal: 37, scaleAdequate: cohort.length >= 40 },
        sample: { size: cohort.length, effectiveFastScale: cohort.length, sha256: SAMPLE_SHA },
        fast: toDtAgg(fast.agg),
        paused: paused ? toDtAgg(paused.agg) : null,
        zeroReplay: zeroAgg,
        pausedDelayMs: paused ? PAUSED_DELAY : null,
      });
      writeJson(OUT, "verdict.json", verdict);
      console.log(`\n=== VERDICT ===\n${JSON.stringify(verdict.evidence, null, 2)}\nrecommendedCaptureRemediation=${verdict.recommendedCaptureRemediation}`);
      if (verdict.recommendedCaptureRemediation === "INSUFFICIENT_EVIDENCE" || verdict.evidence.reproductionAtAdequateScale === "UNPROVEN") exitCode = 2;
      if (verdict.evidence.sessionLoss === "OBSERVED") exitCode = 3;
    }
  } catch (e) {
    console.error("HARNESS_ERROR:", (e as Error).message);
    exitCode = 2;
  } finally {
    await scraper.close().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    if (prevKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = prevKey; // limpiar la key
  }
  console.log(`\nEXIT_CODE=${exitCode}`);
  process.exit(exitCode);
}
main();
