/**
 * Pricing text parsers for verify-prices.ts
 *
 * Extracts structured pricing data from raw page text scraped by Puppeteer.
 */

// ──────────────────────────────────────────────────────────
// Cerebras
// ──────────────────────────────────────────────────────────

export interface CerebrasParsedRow {
    modelName: string;
    inputPer1M: number;
    outputPer1M: number;
}

export function parseCerebrasPricingText(text: string): CerebrasParsedRow[] {
    const rows: CerebrasParsedRow[] = [];
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Look for patterns like:  $X.XX / M tokens
        const inputMatch = line.match(/^\$([0-9.]+)\s*\/\s*M\s*tokens?\s*$/i);
        if (inputMatch) {
            // The model name is typically 1–3 lines before the first price
            const modelName = (lines[i - 1] || "").trim();
            const outputLine = (lines[i + 1] || "").trim();
            const outputMatch = outputLine.match(/^\$([0-9.]+)\s*\/\s*M\s*tokens?\s*$/i);
            if (modelName && outputMatch) {
                rows.push({
                    modelName,
                    inputPer1M: parseFloat(inputMatch[1]),
                    outputPer1M: parseFloat(outputMatch[1]),
                });
                i++; // skip output line
                continue;
            }
        }

        // Alternative: table-style row  "ModelName   $X.XX   $Y.YY"
        const tableMatch = line.match(/^(.+?)\s+\$([0-9.]+)\s+\$([0-9.]+)/);
        if (tableMatch) {
            rows.push({
                modelName: tableMatch[1].trim(),
                inputPer1M: parseFloat(tableMatch[2]),
                outputPer1M: parseFloat(tableMatch[3]),
            });
        }
    }

    return rows;
}

// ──────────────────────────────────────────────────────────
// OVHcloud
// ──────────────────────────────────────────────────────────

export interface OVHcloudParsedRow {
    name: string;
    inputPer1M: number | null;
    outputPer1M: number | null;
    perImage: number | null;
}

export function parseOVHcloudCatalogText(text: string): OVHcloudParsedRow[] {
    const rows: OVHcloudParsedRow[] = [];
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

    let currentModel = "";
    for (const line of lines) {
        // Detect model name lines (no $ sign, looks like a model identifier)
        const modelLine = line.match(/^([\w][\w./-]*(?:-[\w./-]+)+)$/);
        if (modelLine && !modelLine[1].includes("$") && modelLine[1].length < 80) {
            currentModel = modelLine[1];
            continue;
        }

        if (!currentModel) continue;

        // Look for pricing in the line
        const dollarMatches = line.match(/\$\s*([0-9.]+)/g);
        if (dollarMatches && dollarMatches.length > 0) {
            const amounts = dollarMatches.map(m => parseFloat(m.replace("$", "").trim()));
            if (line.toLowerCase().includes("image")) {
                rows.push({
                    name: currentModel,
                    inputPer1M: null,
                    outputPer1M: null,
                    perImage: amounts[0] ?? null,
                });
            } else {
                rows.push({
                    name: currentModel,
                    inputPer1M: amounts[0] ?? null,
                    outputPer1M: amounts[1] ?? null,
                    perImage: null,
                });
            }
            currentModel = "";
        }
    }

    return rows;
}

// ──────────────────────────────────────────────────────────
// WaveSpeed
// ──────────────────────────────────────────────────────────

export interface WaveSpeedParsedResult {
    input: number;
    output: number | null;
    unit: string;
    source: string;
    notes?: string;
}

export interface WaveSpeedPageInput {
    providerId: string;
    html: string;
    text: string;
    sourceUrl: string;
}

export function parseWaveSpeedModelPage(input: WaveSpeedPageInput): WaveSpeedParsedResult | null {
    const { text, sourceUrl } = input;

    // Look for pricing patterns in page text
    const priceMatch = text.match(/\$([0-9.]+)\s*(?:per|\/)\s*(image|megapixel|step|run|second|request)/i);
    if (priceMatch) {
        const amount = parseFloat(priceMatch[1]);
        const unitRaw = priceMatch[2].toLowerCase();
        const unitMap: Record<string, string> = {
            image: "per_image_usd",
            megapixel: "per_megapixel_usd",
            step: "per_step_usd",
            run: "per_run_usd",
            second: "per_second_usd",
            request: "per_request_usd",
        };
        return {
            input: amount,
            output: null,
            unit: unitMap[unitRaw] || `per_${unitRaw}_usd`,
            source: sourceUrl,
        };
    }

    // Look for per-1M-token pricing
    const tokenMatch = text.match(/\$([0-9.]+)\s*(?:per|\/)\s*(?:1M|million)\s*tokens?/i);
    if (tokenMatch) {
        return {
            input: parseFloat(tokenMatch[1]),
            output: null,
            unit: "per_1M_tokens_usd",
            source: sourceUrl,
        };
    }

    return null;
}
