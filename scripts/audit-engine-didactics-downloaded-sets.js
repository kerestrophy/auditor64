#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { Chess } = require("chess.js");

const DEFAULT_DEPTH = 18;
const MULTIPV = 5;
const MIN_TOP1_GAP_CP = 50;
const TOO_MANY_GOOD_MOVES_CP = 35;
const ALREADY_WINNING_CP = 500;
const CLOSE_FAIL_CP = 25;
const DEFAULT_STOCKFISH_PATH = "O:\\e-schachdojo-clean\\auditor64\\src\\main\\resources\\engine\\stockfish.exe";
const DEFAULT_DIR = "O:\\e-schachdojo-clean\\content-audit\\fly-json";
const PROGRESS_EVERY = 25;
const MATE_CP = 100000;

function parseArgs(argv) {
  const args = {
    dir: DEFAULT_DIR,
    stockfish: DEFAULT_STOCKFISH_PATH,
    depth: DEFAULT_DEPTH,
    movetime: null,
    limit: null,
    item: "",
    set: "",
    debug: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--dir" && value) {
      args.dir = value;
      i += 1;
    } else if (key === "--stockfish" && value) {
      args.stockfish = value;
      i += 1;
    } else if (key === "--depth" && value) {
      args.depth = Math.max(1, Number.parseInt(value, 10) || DEFAULT_DEPTH);
      i += 1;
    } else if (key === "--movetime" && value) {
      args.movetime = Math.max(1, Number.parseInt(value, 10) || 0) || null;
      i += 1;
    } else if (key === "--limit" && value) {
      args.limit = Math.max(1, Number.parseInt(value, 10) || 0) || null;
      i += 1;
    } else if (key === "--item" && value) {
      args.item = String(value).trim();
      i += 1;
    } else if (key === "--set" && value) {
      args.set = String(value).trim();
      i += 1;
    } else if (key === "--debug") {
      args.debug = true;
    } else if (key === "--help" || key === "-h") {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log([
    "Usage:",
    "  node scripts/audit-engine-didactics-downloaded-sets.js --dir \"O:\\e-schachdojo-clean\\content-audit\\fly-json\" --stockfish \"O:\\e-schachdojo-clean\\auditor64\\src\\main\\resources\\engine\\stockfish.exe\"",
    "",
    "Options:",
    "  --dir <path>        Directory with downloaded JSON sets. Defaults to the documented fly-json path.",
    "  --stockfish <path>  Stockfish executable path. Defaults to Stockfish 18.1 local path.",
    "  --depth <n>         Search depth. Default: 18.",
    "  --movetime <ms>     Use fixed time instead of depth.",
    "  --limit <n>         Optional local smoke-test item limit.",
    "  --set <setId>       Audit only one set id.",
    "  --item <itemId>     Audit only one item id. Enables targeted single-item filtering.",
    "  --debug             Print detailed per-item flow, normalization, and engine trace."
  ].join("\n"));
}

function walkJsonFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJsonFiles(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

function readJsonFile(filePath) {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

function tokenFromMove(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text || null;
  }
  if (typeof value === "object") {
    const candidates = [
      value.uci,
      value.san,
      value.move,
      value.from && value.to ? `${value.from}${value.to}${value.promotion || ""}` : null,
      value.notation
    ];
    for (const candidate of candidates) {
      const text = candidate === null || candidate === undefined ? "" : String(candidate).trim();
      if (text) return text;
    }
  }
  return null;
}

function tokenizeMoveString(text) {
  return String(text || "")
    .replace(/\r?\n/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !/^\d+\.(\.\.)?$/.test(token))
    .filter((token) => token !== "*" && token !== "1-0" && token !== "0-1" && token !== "1/2-1/2");
}

function flattenMoves(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return tokenizeMoveString(value);
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      if (Array.isArray(item)) {
        out.push(...flattenMoves(item));
      } else {
        const token = tokenFromMove(item);
        if (token) out.push(token);
      }
    }
    return out;
  }
  const token = tokenFromMove(value);
  return token ? [token] : [];
}

function extractTaskContainers(json) {
  const containers = [];
  for (const key of ["puzzles", "items", "tasks"]) {
    if (Array.isArray(json?.[key])) {
      containers.push({ key, items: json[key] });
    }
  }
  if (!containers.length && Array.isArray(json)) {
    containers.push({ key: "root", items: json });
  }
  return containers;
}

function getSetId(json, filePath) {
  return String(
    json?.meta?.id ||
    json?.id ||
    json?.setId ||
    json?.slug ||
    path.basename(filePath, ".json")
  ).trim();
}

function getItemId(item, index) {
  return String(item?.id || item?.itemId || item?.taskId || item?.puzzleId || `item-${index + 1}`).trim();
}

function getFen(item) {
  return String(item?.fen || item?.startFen || item?.position?.fen || "").trim();
}

function extractExpectedFlow(item) {
  const solution = flattenMoves(item?.solution);
  const replies = flattenMoves(item?.autoReply ?? item?.autoReplies);
  const hasAutoReplyField = Object.prototype.hasOwnProperty.call(item || {}, "autoReply") ||
    Object.prototype.hasOwnProperty.call(item || {}, "autoReplies");
  if (solution.length) {
    if (solution.length > 1 && (!hasAutoReplyField || !replies.length)) {
      return {
        steps: [],
        source: "solution",
        assumption: "solution_ambiguous_marked_unclear",
        ambiguous: true,
        expectedUserMovesRaw: []
      };
    }
    const steps = [];
    for (let i = 0; i < solution.length; i += 1) {
      steps.push({ role: "user", raw: solution[i] });
      if (replies[i]) steps.push({ role: "auto", raw: replies[i] });
    }
    return {
      steps,
      source: "solution",
      assumption: hasAutoReplyField ? "solution_user_moves_with_auto_replies" : "solution_single_user_move",
      ambiguous: false,
      expectedUserMovesRaw: solution
    };
  }

  for (const key of ["mainline", "moves", "line"]) {
    const line = flattenMoves(item?.[key]);
    if (line.length) {
      const steps = line.map((raw, index) => ({ role: index % 2 === 0 ? "user" : "auto", raw }));
      return {
        steps,
        source: key,
        assumption: `${key}_alternating_full_line`,
        ambiguous: false,
        expectedUserMovesRaw: steps.filter((step) => step.role === "user").map((step) => step.raw)
      };
    }
  }

  return {
    steps: [],
    source: "none",
    assumption: "no_supported_move_sequence",
    ambiguous: true,
    expectedUserMovesRaw: []
  };
}

function isUci(text) {
  return /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(String(text || "").trim().toLowerCase());
}

function normalizeMoveFromFen(fen, raw) {
  let chess;
  try {
    chess = new Chess(fen);
  } catch (err) {
    return { ok: false, reason: `invalid FEN for move normalization: ${err.message || err}` };
  }

  const text = String(raw || "").trim();
  if (!text) return { ok: false, reason: "empty move" };

  if (isUci(text)) {
    const uci = text.toLowerCase();
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] || undefined
    });
    if (!move) return { ok: false, reason: `illegal UCI move: ${text}` };
    return { ok: true, uci: moveToUci(move), move };
  }

  const sanCandidates = [
    text,
    text.replace(/[!?]+$/g, ""),
    text.replace(/0-0-0/g, "O-O-O"),
    text.replace(/0-0/g, "O-O")
  ].filter((value, index, values) => values.indexOf(value) === index);
  for (const san of sanCandidates) {
    try {
      const move = chess.move(san);
      if (move) return { ok: true, uci: moveToUci(move), move };
    } catch {}
  }
  return { ok: false, reason: `could not normalize SAN/UCI move: ${text}` };
}

function applyMoveToBoard(chess, uci) {
  if (!isUci(uci)) return { ok: false, reason: `invalid UCI move: ${uci}` };
  const move = chess.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci[4] || undefined
  });
  if (!move) return { ok: false, reason: `illegal UCI move on board: ${uci}` };
  return { ok: true, move };
}

function moveToUci(move) {
  return `${move.from}${move.to}${move.promotion || ""}`.toLowerCase();
}

function moveHasDidacticSignal(move, top1GapCp) {
  if (!move) return false;
  const san = String(move.san || "");
  const flags = String(move.flags || "");
  return Boolean(
    move.captured ||
    move.promotion ||
    flags.includes("c") ||
    flags.includes("e") ||
    san.includes("+") ||
    san.includes("#") ||
    Math.abs(top1GapCp || 0) >= 200
  );
}

function inferMateKind(setId, item) {
  const haystack = [
    setId,
    item?.id,
    item?.goal,
    item?.lineType,
    item?.meta?.type,
    item?.dojo?.lineType,
    ...(Array.isArray(item?.tags) ? item.tags : []),
    ...(Array.isArray(item?.trainingTags) ? item.trainingTags : [])
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  const noMate = /\b(no[-_ ]?mate|nomate|kein[-_ ]?matt|ohne[-_ ]?matt)\b/.test(haystack);
  const mate = !noMate && /\b(mate|matt|checkmate)\b/.test(haystack);
  return { noMate, mate };
}

function scoreToCp(score) {
  if (!score) return null;
  if (score.type === "cp") return score.value;
  if (score.type === "mate") {
    const sign = score.value >= 0 ? 1 : -1;
    const distancePenalty = Math.min(90000, Math.abs(score.value) * 1000);
    return sign * (MATE_CP - distancePenalty);
  }
  return null;
}

class StockfishEngine {
  constructor(exePath, options) {
    this.exePath = exePath;
    this.depth = options.depth;
    this.movetime = options.movetime;
    this.proc = null;
    this.buffer = "";
    this.waiters = [];
  }

  async start() {
    this.proc = spawn(this.exePath, [], { windowsHide: true });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk) => {
      const text = String(chunk || "").trim();
      if (text) console.error(`[stockfish stderr] ${text}`);
    });
    this.proc.on("exit", (code, signal) => {
      const err = new Error(`Stockfish exited unexpectedly (code=${code}, signal=${signal})`);
      for (const waiter of this.waiters.splice(0)) waiter.reject(err);
    });
    this.send("uci");
    await this.waitFor((line) => line === "uciok", 10000, "uciok");
    this.send(`setoption name MultiPV value ${MULTIPV}`);
    this.send("isready");
    await this.waitFor((line) => line === "readyok", 10000, "readyok");
  }

  onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      this.handleLine(line.trim());
    }
  }

  handleLine(line) {
    if (!line) return;
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(line)) {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        waiter.resolve(line);
      } else if (waiter.collect) {
        waiter.collect(line);
      }
    }
  }

  send(command) {
    this.proc.stdin.write(`${command}\n`);
  }

  waitFor(predicate, timeoutMs, label, collect) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, collect };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error(`Timed out waiting for ${label}`));
      }, timeoutMs);
      waiter.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      waiter.reject = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      this.waiters.push(waiter);
    });
  }

  async analyze(fen) {
    const multipv = new Map();
    this.send("ucinewgame");
    this.send("isready");
    await this.waitFor((line) => line === "readyok", 10000, "readyok before analyze");
    this.send(`position fen ${fen}`);
    const go = this.movetime ? `go movetime ${this.movetime}` : `go depth ${this.depth}`;
    this.send(go);
    await this.waitFor(
      (line) => line.startsWith("bestmove "),
      Math.max(30000, (this.movetime || 0) + 10000),
      "bestmove",
      (line) => {
        const parsed = parseInfoLine(line);
        if (parsed) multipv.set(parsed.multipv, parsed);
      }
    );
    const topMoves = Array.from(multipv.values())
      .sort((a, b) => a.multipv - b.multipv)
      .slice(0, MULTIPV);
    return { topMoves };
  }

  stop() {
    if (!this.proc) return;
    try {
      this.send("quit");
    } catch {}
    this.proc = null;
  }
}

function parseInfoLine(line) {
  if (!line.startsWith("info ")) return null;
  const parts = line.split(/\s+/);
  const multipvIndex = parts.indexOf("multipv");
  const scoreIndex = parts.indexOf("score");
  const pvIndex = parts.indexOf("pv");
  const depthIndex = parts.indexOf("depth");
  if (scoreIndex < 0 || pvIndex < 0 || pvIndex + 1 >= parts.length) return null;
  const multipv = multipvIndex >= 0 ? Number.parseInt(parts[multipvIndex + 1], 10) || 1 : 1;
  const depth = depthIndex >= 0 ? Number.parseInt(parts[depthIndex + 1], 10) || null : null;
  const scoreType = parts[scoreIndex + 1];
  const scoreValue = Number.parseInt(parts[scoreIndex + 2], 10);
  const score = Number.isFinite(scoreValue) ? { type: scoreType, value: scoreValue } : null;
  const pv = parts.slice(pvIndex + 1).filter(isUci);
  if (!pv.length) return null;
  return {
    rank: multipv,
    multipv,
    depth,
    move: pv[0],
    pv,
    score,
    scoreCp: scoreToCp(score),
    scoreText: score ? `${score.type} ${score.value}` : ""
  };
}

function getTop1GapCp(topMoves) {
  if (!topMoves || topMoves.length < 2) return null;
  const a = topMoves[0].scoreCp;
  const b = topMoves[1].scoreCp;
  if (a === null || b === null || a === undefined || b === undefined) return null;
  return a - b;
}

function countGoodMovesNearTop(topMoves, threshold) {
  if (!topMoves?.length || topMoves[0].scoreCp === null || topMoves[0].scoreCp === undefined) return 0;
  const top = topMoves[0].scoreCp;
  return topMoves.filter((move) => move.scoreCp !== null && move.scoreCp !== undefined && top - move.scoreCp <= threshold).length;
}

function classifyEngineFail(topMoves, expectedUci) {
  const top1 = topMoves?.[0] || null;
  const expected = (Array.isArray(topMoves) ? topMoves : []).find((move) => move.move === expectedUci) || null;
  if (!top1) {
    return { status: "engineUnclear", warning: "ENGINE_UNCLEAR", reasonSuffix: "No engine top move returned.", expectedEngineMove: null };
  }
  if (top1.move === expectedUci) {
    return { status: "enginePass", warning: null, reasonSuffix: "Expected move is Stockfish Top-1.", expectedEngineMove: top1 };
  }
  if (
    expected?.score?.type === "mate" &&
    top1.score?.type === "mate" &&
    Math.sign(Number(expected.score.value)) === Math.sign(Number(top1.score.value)) &&
    Math.abs(Number(expected.score.value)) === Math.abs(Number(top1.score.value))
  ) {
    return {
      status: "ENGINE_FAIL_SAME_MATE_DISTANCE",
      warning: "ENGINE_FAIL_SAME_MATE_DISTANCE",
      reasonSuffix: `Expected move is not Top-1, but has the same mate distance as ${top1.move}.`,
      expectedEngineMove: expected
    };
  }
  if (
    expected &&
    Number.isFinite(Number(top1.scoreCp)) &&
    Number.isFinite(Number(expected.scoreCp)) &&
    Number(top1.scoreCp) - Number(expected.scoreCp) <= CLOSE_FAIL_CP
  ) {
    return {
      status: "ENGINE_FAIL_CLOSE",
      warning: "ENGINE_FAIL_CLOSE",
      reasonSuffix: `Expected move is not Top-1, but is within ${CLOSE_FAIL_CP}cp of ${top1.move}.`,
      expectedEngineMove: expected
    };
  }
  return {
    status: "ENGINE_FAIL_CLEAR",
    warning: "ENGINE_FAIL_CLEAR",
    reasonSuffix: `Expected move is not Top-1; Stockfish prefers ${top1.move}.`,
    expectedEngineMove: expected
  };
}

async function auditItem(engine, filePath, setId, item, itemIndex, options = {}) {
  const itemId = getItemId(item, itemIndex);
  const fen = getFen(item);
  const flow = extractExpectedFlow(item);
  const result = {
    filePath,
    setId,
    itemId,
    fen,
    sideToMove: "",
    expectedUserMovesRaw: flow.expectedUserMovesRaw,
    expectedUserMovesUci: [],
    flow: {
      source: flow.source,
      assumption: flow.assumption,
      ambiguous: flow.ambiguous,
      steps: flow.steps.map((step) => ({ role: step.role, raw: step.raw }))
    },
    engineResults: [],
    didacticWarnings: [],
    didacticRiskScore: 0,
    finalStatus: "unclear",
    errors: [],
    debug: options.debug ? {
      rawItemKeys: Object.keys(item || {}),
      steps: []
    } : undefined
  };

  let chess;
  try {
    chess = new Chess(fen);
    result.sideToMove = chess.turn();
  } catch (err) {
    result.didacticWarnings.push("ENGINE_UNCLEAR");
    result.errors.push(`Invalid FEN: ${err.message || err}`);
    finalizeDidactics(result);
    return result;
  }

  if (!flow.steps.length || !flow.expectedUserMovesRaw.length) {
    result.didacticWarnings.push("ENGINE_UNCLEAR");
    result.errors.push(flow.ambiguous
      ? `Ambiguous move sequence: ${flow.assumption}`
      : "No unambiguous user move sequence found.");
    finalizeDidactics(result);
    return result;
  }

  const mateKind = inferMateKind(setId, item);
  let userMoveCount = 0;
  let firstMoveChecked = false;

  for (let plyIndex = 0; plyIndex < flow.steps.length; plyIndex += 1) {
    const step = flow.steps[plyIndex];
    if (!step?.raw) continue;
    const debugStep = options.debug ? {
      plyIndex,
      role: step.role,
      rawMove: step.raw,
      fenBeforeStep: chess.fen(),
      normalizedUci: null,
      appliedLegal: false,
      reason: ""
    } : null;
    if (step.role !== "user") {
      const fenBeforeAuto = chess.fen();
      const auto = normalizeMoveFromFen(fenBeforeAuto, step.raw);
      if (debugStep) {
        debugStep.fenBeforeStep = fenBeforeAuto;
        debugStep.normalizedUci = auto.ok ? auto.uci : null;
        debugStep.reason = auto.ok ? "" : auto.reason;
      }
      if (!auto.ok) {
        result.engineResults.push({
          plyIndex,
          role: "auto",
          fenBeforeMove: fenBeforeAuto,
          expectedMoveRaw: step.raw,
          expectedMoveUci: null,
          engineTop1: null,
          engineTopMoves: [],
          top1GapCp: null,
          evalBefore: null,
          status: "engineUnclear",
          reason: `Auto-reply unclear: ${auto.reason}`
        });
        result.didacticWarnings.push("ENGINE_UNCLEAR");
        if (debugStep) result.debug.steps.push(debugStep);
        break;
      }
      const appliedAuto = applyMoveToBoard(chess, auto.uci);
      if (debugStep) {
        debugStep.appliedLegal = appliedAuto.ok;
        debugStep.reason = appliedAuto.ok ? "" : appliedAuto.reason;
      }
      if (!appliedAuto.ok) {
        result.engineResults.push({
          plyIndex,
          role: "auto",
          fenBeforeMove: fenBeforeAuto,
          expectedMoveRaw: step.raw,
          expectedMoveUci: auto.uci,
          engineTop1: null,
          engineTopMoves: [],
          top1GapCp: null,
          evalBefore: null,
          status: "engineUnclear",
          reason: `Auto-reply could not be applied: ${appliedAuto.reason}`
        });
        result.didacticWarnings.push("ENGINE_UNCLEAR");
        if (debugStep) result.debug.steps.push(debugStep);
        break;
      }
      if (debugStep) result.debug.steps.push(debugStep);
      continue;
    }

    userMoveCount += 1;
    const fenBeforeMove = chess.fen();
    const normalized = normalizeMoveFromFen(fenBeforeMove, step.raw);
    if (debugStep) {
      debugStep.fenBeforeStep = fenBeforeMove;
      debugStep.normalizedUci = normalized.ok ? normalized.uci : null;
      debugStep.reason = normalized.ok ? "" : normalized.reason;
    }
    if (!normalized.ok) {
      result.engineResults.push({
        plyIndex,
        fenBeforeMove,
        expectedMoveRaw: step.raw,
        expectedMoveUci: null,
        engineTop1: null,
        engineTopMoves: [],
        top1GapCp: null,
        evalBefore: null,
        status: "engineUnclear",
        reason: normalized.reason
      });
      result.didacticWarnings.push("ENGINE_UNCLEAR");
      if (debugStep) result.debug.steps.push(debugStep);
      break;
    }

    result.expectedUserMovesUci.push(normalized.uci);

    let analysis;
    try {
      analysis = await engine.analyze(fenBeforeMove);
    } catch (err) {
      result.engineResults.push({
        plyIndex,
        fenBeforeMove,
        expectedMoveRaw: step.raw,
        expectedMoveUci: normalized.uci,
        engineTop1: null,
        engineTopMoves: [],
        top1GapCp: null,
        evalBefore: null,
        status: "engineUnclear",
        reason: `Engine analysis failed: ${err.message || err}`
      });
      result.didacticWarnings.push("ENGINE_UNCLEAR");
      break;
    }

    const topMoves = analysis.topMoves || [];
    const top1 = topMoves[0] || null;
    const top1GapCp = getTop1GapCp(topMoves);
    const evalBefore = top1?.score || null;
    const failClassification = classifyEngineFail(topMoves, normalized.uci);
    const expectedIsTop1 = failClassification.status === "enginePass";
    const status = failClassification.status;
    const reason = failClassification.reasonSuffix;
    if (debugStep) {
      debugStep.engineTopMoves = topMoves.map(formatEngineMove);
      debugStep.expectedMoveUci = normalized.uci;
      debugStep.expectedIsTop1 = expectedIsTop1;
      debugStep.top1GapCp = top1GapCp;
      debugStep.evalBefore = evalBefore;
      debugStep.engineStatus = status;
      debugStep.expectedEngineMove = failClassification.expectedEngineMove ? formatEngineMove(failClassification.expectedEngineMove) : null;
      debugStep.reason = reason;
    }

    result.engineResults.push({
      plyIndex,
      role: "user",
      fenBeforeMove,
      expectedMoveRaw: step.raw,
      expectedMoveUci: normalized.uci,
      engineTop1: top1?.move || null,
      engineTopMoves: topMoves.map(formatEngineMove),
      expectedEngineMove: failClassification.expectedEngineMove ? formatEngineMove(failClassification.expectedEngineMove) : null,
      engineFailType: status.startsWith("ENGINE_FAIL_") ? status : null,
      top1GapCp,
      evalBefore,
      status,
      reason
    });

    if (failClassification.warning) {
      result.didacticWarnings.push(failClassification.warning);
      if (plyIndex >= 2 && (failClassification.warning === "ENGINE_FAIL_CLOSE" || failClassification.warning === "ENGINE_FAIL_CLEAR")) {
        result.didacticWarnings.push(`SECOND_USER_${failClassification.warning}`);
      }
    } else {
      if (top1GapCp !== null && top1GapCp < MIN_TOP1_GAP_CP) {
        result.didacticWarnings.push("LOW_TOP1_GAP");
      }
      if (countGoodMovesNearTop(topMoves, TOO_MANY_GOOD_MOVES_CP) > 1) {
        result.didacticWarnings.push("TOO_MANY_GOOD_MOVES");
      }
      if (!firstMoveChecked) {
        const evalCp = top1.scoreCp;
        if (evalCp !== null && evalCp !== undefined && evalCp > ALREADY_WINNING_CP) {
          result.didacticWarnings.push("ALREADY_WINNING");
        }
        if (!moveHasDidacticSignal(normalized.move, top1GapCp)) {
          result.didacticWarnings.push("LOW_DIDACTIC_SIGNAL");
        }
      }
      if (mateKind.noMate && top1.score?.type === "mate" && Math.abs(top1.score.value) <= 5) {
        result.didacticWarnings.push("TAG_MISMATCH_POSSIBLE");
      }
    }
    firstMoveChecked = true;
    const appliedUserMove = applyMoveToBoard(chess, normalized.uci);
    if (debugStep) {
      debugStep.appliedLegal = appliedUserMove.ok;
      if (!appliedUserMove.ok) debugStep.reason = appliedUserMove.reason;
    }
    if (!appliedUserMove.ok) {
      result.engineResults.push({
        plyIndex,
        role: "user",
        fenBeforeMove,
        expectedMoveRaw: step.raw,
        expectedMoveUci: normalized.uci,
        engineTop1: top1?.move || null,
        engineTopMoves: topMoves.map(formatEngineMove),
        top1GapCp,
        evalBefore,
        status: "engineUnclear",
        reason: `Expected move could not be applied after analysis: ${appliedUserMove.reason}`
      });
      result.didacticWarnings.push("ENGINE_UNCLEAR");
      if (debugStep) result.debug.steps.push(debugStep);
      break;
    }
    if (debugStep) result.debug.steps.push(debugStep);
  }

  if (userMoveCount > 3) {
    result.didacticWarnings.push("LONG_SOLUTION");
  }
  if (mateKind.noMate) result.noMate = true;
  if (mateKind.mate) result.mate = true;
  finalizeDidactics(result);
  return result;
}

function formatEngineMove(move) {
  return {
    rank: move.rank,
    move: move.move,
    score: move.score,
    scoreCp: move.scoreCp,
    scoreText: move.scoreText,
    depth: move.depth,
    pv: move.pv
  };
}

function finalizeDidactics(result) {
  result.didacticWarnings = Array.from(new Set(result.didacticWarnings));
  const weights = {
    ENGINE_FAIL_CLEAR: 100,
    ENGINE_FAIL_CLOSE: 60,
    ENGINE_FAIL_SAME_MATE_DISTANCE: 40,
    ENGINE_UNCLEAR: 60,
    LOW_TOP1_GAP: 25,
    TOO_MANY_GOOD_MOVES: 25,
    ALREADY_WINNING: 15,
    LONG_SOLUTION: 15,
    TAG_MISMATCH_POSSIBLE: 30,
    LOW_DIDACTIC_SIGNAL: 10,
    SECOND_USER_ENGINE_FAIL_CLEAR: 0,
    SECOND_USER_ENGINE_FAIL_CLOSE: 0
  };
  result.didacticRiskScore = Math.min(100, result.didacticWarnings.reduce((sum, warning) => sum + (weights[warning] || 0), 0));
  const statuses = result.engineResults.map((entry) => entry.status);
  const failEntries = result.engineResults.filter((entry) => String(entry.status || "").startsWith("ENGINE_FAIL_"));
  const hasHardFail = failEntries.some((entry) => (Number(entry.plyIndex) || 0) === 0 || entry.status === "ENGINE_FAIL_CLEAR");
  if (failEntries.length && hasHardFail) {
    result.finalStatus = "releaseBlocker";
  } else if (!statuses.length || statuses.every((status) => status === "engineUnclear")) {
    result.finalStatus = "unclear";
  } else if (failEntries.length || statuses.includes("engineUnclear") || result.didacticRiskScore >= 40) {
    result.finalStatus = "needsHumanReview";
  } else {
    result.finalStatus = "ok";
  }
}

function summarizeSets(itemResults, fileSummaries) {
  const bySet = new Map();
  for (const fileSummary of fileSummaries) {
    if (!bySet.has(fileSummary.setId)) {
      bySet.set(fileSummary.setId, {
        setId: fileSummary.setId,
        filePath: fileSummary.filePath,
        totalItems: 0,
        checkedItems: 0,
        okCount: 0,
        needsHumanReviewCount: 0,
        releaseBlockerCount: 0,
        unclearCount: 0,
        averageDidacticRiskScore: 0,
        worstDidacticRiskScore: 0,
        noMateCount: 0,
        mateCount: 0,
        quarantineCandidate: false,
        deleteCandidate: false,
        releaseCandidate: false
      });
    }
    bySet.get(fileSummary.setId).totalItems += fileSummary.totalItems;
  }

  for (const item of itemResults) {
    const set = bySet.get(item.setId);
    if (!set) continue;
    set.checkedItems += item.engineResults.length ? 1 : 0;
    if (item.finalStatus === "ok") set.okCount += 1;
    if (item.finalStatus === "needsHumanReview") set.needsHumanReviewCount += 1;
    if (item.finalStatus === "releaseBlocker") set.releaseBlockerCount += 1;
    if (item.finalStatus === "unclear") set.unclearCount += 1;
    if (item.noMate) set.noMateCount += 1;
    if (item.mate) set.mateCount += 1;
    set.worstDidacticRiskScore = Math.max(set.worstDidacticRiskScore, item.didacticRiskScore || 0);
  }

  for (const set of bySet.values()) {
    const items = itemResults.filter((item) => item.setId === set.setId);
    set.averageDidacticRiskScore = items.length
      ? Math.round(items.reduce((sum, item) => sum + (item.didacticRiskScore || 0), 0) / items.length)
      : 0;
    const releaseBlockerRate = set.totalItems ? set.releaseBlockerCount / set.totalItems : 0;
    set.quarantineCandidate = set.releaseBlockerCount > 0 || set.needsHumanReviewCount >= 3;
    set.deleteCandidate = set.releaseBlockerCount >= 3 || releaseBlockerRate >= 0.02;
    set.releaseCandidate = set.releaseBlockerCount === 0 && set.unclearCount === 0;
  }

  return Array.from(bySet.values()).sort((a, b) => a.setId.localeCompare(b.setId));
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeReports(report) {
  const reportsDir = path.resolve(process.cwd(), "data", "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const jsonPath = path.join(reportsDir, `engine-didactics-audit-${date}.json`);
  const csvPath = path.join(reportsDir, `engine-didactics-audit-${date}.csv`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");

  const header = [
    "filePath",
    "setId",
    "itemId",
    "finalStatus",
    "didacticRiskScore",
    "warnings",
    "expectedUserMovesRaw",
    "expectedUserMovesUci",
    "firstEngineTop1",
    "firstTopMoves",
    "firstReason"
  ];
  const rows = [header.join(",")];
  for (const item of report.items) {
    const first = item.engineResults[0] || {};
    rows.push([
      item.filePath,
      item.setId,
      item.itemId,
      item.finalStatus,
      item.didacticRiskScore,
      item.didacticWarnings.join("|"),
      item.expectedUserMovesRaw.join(" "),
      item.expectedUserMovesUci.join(" "),
      first.engineTop1 || "",
      (first.engineTopMoves || []).map((move) => `${move.rank}:${move.move}:${move.scoreText}`).join(" "),
      [first.engineFailType, first.reason || item.errors?.join("; ") || ""].filter(Boolean).join(" ")
    ].map(csvEscape).join(","));
  }
  fs.writeFileSync(csvPath, `${rows.join("\n")}\n`, "utf8");
  return { jsonPath, csvPath };
}

function printSummary(report, reportPaths) {
  const summary = report.summary;
  console.log("");
  console.log("Engine + didactics audit summary");
  console.log("--------------------------------");
  console.log(`Sets: ${summary.setCount}`);
  console.log(`Tasks: ${summary.totalItems}`);
  console.log(`Checked tasks: ${summary.checkedItems}`);
  console.log(`OK: ${summary.okCount}`);
  console.log(`Needs human review: ${summary.needsHumanReviewCount}`);
  console.log(`Release blockers: ${summary.releaseBlockerCount}`);
  console.log(`Unclear: ${summary.unclearCount}`);
  console.log(`Sets with release blockers: ${summary.setsWithReleaseBlockers}`);
  console.log(`Quarantine candidates: ${summary.quarantineCandidates}`);
  console.log(`Delete candidates: ${summary.deleteCandidates}`);
  console.log("");
  console.log("Most critical tasks");
  console.log("-------------------");
  for (const item of report.criticalItems.slice(0, 30)) {
    const first = item.engineResults.find((entry) => entry.status !== "enginePass") || item.engineResults[0] || {};
    const topMoves = (first.engineTopMoves || []).map((move) => `${move.rank}:${move.move}(${move.scoreText})`).join(" ");
    console.log([
      `${item.setId} / ${item.itemId}`,
      item.finalStatus,
      `risk=${item.didacticRiskScore}`,
      `warnings=${item.didacticWarnings.join("|") || "-"}`,
      `failType=${first.engineFailType || (String(first.status || "").startsWith("ENGINE_FAIL_") ? first.status : "-")}`,
      `plyIndex=${first.plyIndex ?? "-"}`,
      `actor=${first.role || "-"}`,
      `expected=${first.expectedMoveUci || item.expectedUserMovesUci[0] || item.expectedUserMovesRaw[0] || "-"}`,
      `top1=${first.engineTop1 || "-"}`,
      `topMoves=${topMoves || "-"}`,
      `reason=${first.reason || item.errors?.join("; ") || "-"}`
    ].join(" | "));
  }
  console.log("");
  console.log(`JSON report: ${reportPaths.jsonPath}`);
  console.log(`CSV report: ${reportPaths.csvPath}`);
}

function printDebugItemResult(result) {
  console.log("");
  console.log("Single item debug");
  console.log("-----------------");
  console.log(`setId: ${result.setId}`);
  console.log(`itemId: ${result.itemId}`);
  console.log(`raw item keys: ${(result.debug?.rawItemKeys || []).join(", ") || "-"}`);
  console.log(`fen: ${result.fen || "-"}`);
  console.log(`sideToMove from FEN: ${result.sideToMove || "-"}`);
  console.log("");
  console.log("Detected flow");
  console.log(`source: ${result.flow?.source || "-"}`);
  console.log(`assumption: ${result.flow?.assumption || "-"}`);
  console.log(`ambiguous: ${result.flow?.ambiguous === true ? "true" : "false"}`);
  for (const [index, step] of (result.flow?.steps || []).entries()) {
    console.log(`  ${index + 1}. role=${step.role || "-"} raw=${step.raw || "-"}`);
  }
  console.log("");
  console.log("Step trace");
  for (const step of (result.debug?.steps || [])) {
    console.log(`step ${Number(step.plyIndex) + 1} | role=${step.role} | raw=${step.rawMove} | uci=${step.normalizedUci || "-"} | applied=${step.appliedLegal ? "yes" : "no"}`);
    console.log(`  fenBeforeStep: ${step.fenBeforeStep || "-"}`);
    if (step.role === "user") {
      const topMoves = (step.engineTopMoves || []).map((move) => `${move.rank}:${move.move}(${move.scoreText})`).join(" ");
      console.log(`  expectedMoveUci: ${step.expectedMoveUci || "-"}`);
      console.log(`  expectedIsTop1: ${step.expectedIsTop1 === true ? "yes" : "no"}`);
      console.log(`  engineStatus: ${step.engineStatus || "-"}`);
      console.log(`  evalBefore: ${step.evalBefore ? `${step.evalBefore.type} ${step.evalBefore.value}` : "-"}`);
      console.log(`  top1GapCp: ${step.top1GapCp ?? "-"}`);
      console.log(`  topMoves: ${topMoves || "-"}`);
      if (step.expectedEngineMove) {
        console.log(`  expectedEngineMove: ${step.expectedEngineMove.rank}:${step.expectedEngineMove.move}(${step.expectedEngineMove.scoreText})`);
      }
    }
    if (step.reason) console.log(`  reason: ${step.reason}`);
  }
  console.log("");
  console.log(`finalStatus: ${result.finalStatus}`);
  console.log(`didacticWarnings: ${result.didacticWarnings.join("|") || "-"}`);
  console.log(`didacticRiskScore: ${result.didacticRiskScore}`);
  if (result.errors?.length) console.log(`errors: ${result.errors.join("; ")}`);
}

function buildSummary(setSummaries, itemResults) {
  return {
    setCount: setSummaries.length,
    totalItems: setSummaries.reduce((sum, set) => sum + set.totalItems, 0),
    checkedItems: itemResults.filter((item) => item.engineResults.length).length,
    okCount: itemResults.filter((item) => item.finalStatus === "ok").length,
    needsHumanReviewCount: itemResults.filter((item) => item.finalStatus === "needsHumanReview").length,
    releaseBlockerCount: itemResults.filter((item) => item.finalStatus === "releaseBlocker").length,
    unclearCount: itemResults.filter((item) => item.finalStatus === "unclear").length,
    setsWithReleaseBlockers: setSummaries.filter((set) => set.releaseBlockerCount > 0).length,
    quarantineCandidates: setSummaries.filter((set) => set.quarantineCandidate).length,
    deleteCandidates: setSummaries.filter((set) => set.deleteCandidate).length
  };
}

function sortCriticalItems(items) {
  return [...items]
    .filter((item) => item.finalStatus !== "ok" || item.didacticRiskScore >= 40)
    .sort((a, b) => {
      const statusRank = { releaseBlocker: 0, unclear: 1, needsHumanReview: 2, ok: 3 };
      const aEngineFail = a.didacticWarnings.some((warning) => String(warning).startsWith("ENGINE_FAIL_")) ? 0 : 1;
      const bEngineFail = b.didacticWarnings.some((warning) => String(warning).startsWith("ENGINE_FAIL_")) ? 0 : 1;
      const aUnclear = a.didacticWarnings.includes("ENGINE_UNCLEAR") ? 0 : 1;
      const bUnclear = b.didacticWarnings.includes("ENGINE_UNCLEAR") ? 0 : 1;
      return (statusRank[a.finalStatus] ?? 9) - (statusRank[b.finalStatus] ?? 9) ||
        b.didacticRiskScore - a.didacticRiskScore ||
        aEngineFail - bEngineFail ||
        aUnclear - bUnclear ||
        a.setId.localeCompare(b.setId) ||
        a.itemId.localeCompare(b.itemId);
    });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  const inputDir = path.resolve(args.dir);
  const stockfishPath = path.resolve(args.stockfish);
  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    console.error(`Input directory not found: ${inputDir}`);
    return 1;
  }
  if (!fs.existsSync(stockfishPath)) {
    console.error(`Stockfish executable not found: ${stockfishPath}`);
    return 1;
  }

  const files = walkJsonFiles(inputDir);
  const fileSummaries = [];
  const tasks = [];
  const readErrors = [];

  for (const filePath of files) {
    const parsed = readJsonFile(filePath);
    if (!parsed.ok) {
      readErrors.push({ filePath, error: parsed.error });
      continue;
    }
    const setId = getSetId(parsed.data, filePath);
    if (args.set && setId !== args.set) continue;
    let totalItems = 0;
    let matchedItems = 0;
    for (const container of extractTaskContainers(parsed.data)) {
      totalItems += container.items.length;
      container.items.forEach((item, index) => {
        const itemId = getItemId(item, index);
        if (args.item && itemId !== args.item) return;
        tasks.push({ filePath, setId, item, index });
        matchedItems += 1;
      });
    }
    if (!args.item || matchedItems > 0) {
      fileSummaries.push({ filePath, setId, totalItems: args.item ? matchedItems : totalItems });
    }
  }

  if (args.item) {
    console.log(`Target item mode: item=${args.item}${args.set ? ` set=${args.set}` : ""}`);
  } else if (args.set) {
    console.log(`Target set mode: set=${args.set}`);
  }

  if (args.limit && !args.item) {
    tasks.length = Math.min(tasks.length, args.limit);
  }

  console.log(`Found ${files.length} JSON files, ${tasks.length} tasks to audit.`);
  if (args.limit && !args.item) {
    console.log(`SMOKE TEST LIMIT ACTIVE: only ${args.limit} tasks will be audited.`);
  }
  if (args.item && !tasks.length) {
    console.error(`Item not found: ${args.item}${args.set ? ` in set ${args.set}` : ""}`);
    return 1;
  }
  console.log(`Stockfish: ${stockfishPath}`);
  console.log(args.movetime ? `Analysis: movetime ${args.movetime} ms, MultiPV ${MULTIPV}` : `Analysis: depth ${args.depth}, MultiPV ${MULTIPV}`);

  const engine = new StockfishEngine(stockfishPath, { depth: args.depth, movetime: args.movetime });
  const itemResults = [];
  try {
    await engine.start();
    for (let i = 0; i < tasks.length; i += 1) {
      if (i > 0 && i % PROGRESS_EVERY === 0) {
        console.log(`Progress: ${i}/${tasks.length} tasks audited.`);
      }
      const task = tasks[i];
      try {
        const result = await auditItem(engine, task.filePath, task.setId, task.item, task.index, { debug: args.debug || !!args.item });
        itemResults.push(result);
      } catch (err) {
        const fallback = {
          filePath: task.filePath,
          setId: task.setId,
          itemId: getItemId(task.item, task.index),
          fen: getFen(task.item),
          sideToMove: "",
          expectedUserMovesRaw: [],
          expectedUserMovesUci: [],
          engineResults: [],
          didacticWarnings: ["ENGINE_UNCLEAR"],
          didacticRiskScore: 60,
          finalStatus: "unclear",
          errors: [`Unexpected item audit error: ${err.message || err}`]
        };
        itemResults.push(fallback);
      }
    }
  } finally {
    engine.stop();
  }

  const setSummaries = summarizeSets(itemResults, fileSummaries);
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      inputDir,
      stockfishPath,
      depth: args.depth,
      movetime: args.movetime,
      constants: {
        DEFAULT_DEPTH,
        MULTIPV,
        MIN_TOP1_GAP_CP,
        TOO_MANY_GOOD_MOVES_CP,
        ALREADY_WINNING_CP,
        CLOSE_FAIL_CP,
        DEFAULT_STOCKFISH_PATH
      },
      readErrors
    },
    summary: buildSummary(setSummaries, itemResults),
    sets: setSummaries,
    items: itemResults,
    criticalItems: sortCriticalItems(itemResults)
  };
  const reportPaths = writeReports(report);
  if (args.debug || args.item) {
    for (const item of itemResults) printDebugItemResult(item);
  }
  printSummary(report, reportPaths);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`Audit failed: ${err.stack || err.message || err}`);
    process.exitCode = 1;
  });
