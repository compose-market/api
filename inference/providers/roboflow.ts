const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
const ROBOFLOW_DEFAULT_PROJECT = process.env.ROBOFLOW_DEFAULT_PROJECT;
const ROBOFLOW_DEFAULT_VERSION = process.env.ROBOFLOW_DEFAULT_VERSION;

if (!ROBOFLOW_API_KEY) {
    console.warn("[roboflow] ROBOFLOW_API_KEY not set — Roboflow vision disabled");
}

function requireRoboflowApiKey(): string {
    if (!ROBOFLOW_API_KEY) {
        throw new Error("ROBOFLOW_API_KEY not configured");
    }
    return ROBOFLOW_API_KEY;
}

function resolveRoboflowTarget(modelId: string): { project: string; version: string } {
    const withoutPrefix = modelId.replace(/^roboflow\//, "");
    if (withoutPrefix === "default" || withoutPrefix === "detect" || withoutPrefix === "latest") {
        if (!ROBOFLOW_DEFAULT_PROJECT || !ROBOFLOW_DEFAULT_VERSION) {
            throw new Error("ROBOFLOW_DEFAULT_PROJECT and ROBOFLOW_DEFAULT_VERSION are required");
        }
        return { project: ROBOFLOW_DEFAULT_PROJECT, version: ROBOFLOW_DEFAULT_VERSION };
    }
    const parts = withoutPrefix.split("/").filter(Boolean);
    if (parts.length >= 2) {
        return { project: parts[0], version: parts[1] };
    }
    if (!ROBOFLOW_DEFAULT_PROJECT || !ROBOFLOW_DEFAULT_VERSION) {
        throw new Error("Roboflow project/version is required");
    }
    return { project: ROBOFLOW_DEFAULT_PROJECT, version: ROBOFLOW_DEFAULT_VERSION };
}

export async function analyzeRoboflowImage(args: {
    modelId: string;
    imageBuffer: Buffer;
    prompt?: string;
}): Promise<{ text: string; raw: Record<string, unknown> }> {
    const target = resolveRoboflowTarget(args.modelId);
    const response = await fetch(
        `https://detect.roboflow.com/${encodeURIComponent(target.project)}/${encodeURIComponent(target.version)}?api_key=${encodeURIComponent(requireRoboflowApiKey())}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: `image=${encodeURIComponent(args.imageBuffer.toString("base64"))}`,
        },
    );

    if (!response.ok) {
        throw new Error(`Roboflow inference failed: ${response.status} ${await response.text()}`);
    }

    const payload = await response.json() as {
        predictions?: Array<Record<string, unknown>>;
        image?: { width?: number; height?: number };
    };

    const predictions = Array.isArray(payload.predictions) ? payload.predictions : [];
    const text = summarizePredictions(predictions, args.prompt);
    return { text, raw: payload as Record<string, unknown> };
}

function summarizePredictions(predictions: Array<Record<string, unknown>>, prompt?: string): string {
    if (predictions.length === 0) {
        return prompt
            ? `Roboflow found no detections relevant to: ${prompt}.`
            : "Roboflow found no detections in the supplied image.";
    }

    const lines = predictions.slice(0, 12).map((prediction, index) => {
        const label = typeof prediction.class === "string"
            ? prediction.class
            : typeof prediction.label === "string"
                ? prediction.label
                : `object_${index + 1}`;
        const confidence = typeof prediction.confidence === "number"
            ? `${(prediction.confidence * 100).toFixed(1)}%`
            : "unknown confidence";
        const x = typeof prediction.x === "number" ? prediction.x.toFixed(0) : "?";
        const y = typeof prediction.y === "number" ? prediction.y.toFixed(0) : "?";
        const width = typeof prediction.width === "number" ? prediction.width.toFixed(0) : "?";
        const height = typeof prediction.height === "number" ? prediction.height.toFixed(0) : "?";
        return `${label} at (${x}, ${y}) size ${width}x${height} confidence ${confidence}`;
    });

    const preface = prompt
        ? `Roboflow detections for "${prompt}":`
        : "Roboflow detections:";

    return [preface, ...lines].join("\n");
}
