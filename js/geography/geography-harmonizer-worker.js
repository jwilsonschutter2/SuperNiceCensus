/**
 * High-coverage LATS-style temporal relationship resolver.
 * 1) Lock exact GEOID matches one-to-one.
 * 2) Relate remaining same-county features by positive polygon overlap.
 * 3) Add containment edges for remaining geographies. These edges may complete merges/splits.
 * 4) Do not assign by proximity. Unmatched records remain explicit exceptions.
 */
importScripts("https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js");

self.onmessage = (event) => {
  try {
    self.postMessage(build(event.data));
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};

function build({ sourceFeatures, targetFeatures, options = {} }) {
  const sliverThreshold = Number(options.sliverThreshold) || 0.0001;
  const sources = sourceFeatures.map(prep).filter(Boolean);
  const targets = targetFeatures.map(prep).filter(Boolean);
  const sourceById = new Map(sources.map((x) => [x.id, x]));
  const targetById = new Map(targets.map((x) => [x.id, x]));
  const relationships = [];
  const diagnostics = [];
  const lockedSources = new Set();
  const lockedTargets = new Set();
  let intersectionErrors = 0;
  const intersectionErrorSamples = [];

  // Pass 1: exact GEOID continuity, exclusively one-to-one.
  for (const [id, source] of sourceById) {
    const target = targetById.get(id);
    if (!target) continue;
    const evidence = overlapEvidence(source, target);
    if (evidence.error) recordIntersectionError(source.id, target.id, evidence.message);
    relationships.push({
      source: id,
      target: id,
      intersectionArea: evidence.area,
      sourceShare: evidence.area / source.area,
      targetShare: evidence.area / target.area,
      sameGeoid: true,
      sameCounty: true,
      stableVerified: true,
      method: "exact-geoid",
      forced: false,
    });
    lockedSources.add(id);
    lockedTargets.add(id);
  }

  // Pass 2: complete residual overlap graph. Locked exact matches are never reused.
  for (const source of sources) {
    if (lockedSources.has(source.id)) continue;
    for (const target of targets) {
      if (lockedTargets.has(target.id)) continue;
      if (!sameCounty(source.id, target.id) || !bboxTouches(source.box, target.box)) continue;
      const evidence = overlapEvidence(source, target);
      if (evidence.error) {
        recordIntersectionError(source.id, target.id, evidence.message);
        continue;
      }
      if (evidence.area <= 0) continue;
      const sourceShare = evidence.area / source.area;
      const targetShare = evidence.area / target.area;
      if (sourceShare < sliverThreshold && targetShare < sliverThreshold) continue;
      relationships.push({
        source: source.id,
        target: target.id,
        intersectionArea: evidence.area,
        sourceShare,
        targetShare,
        sameGeoid: false,
        sameCounty: true,
        stableVerified: false,
        method: "polygon-intersection",
        forced: false,
      });
    }
  }

  // Pass 3: containment evidence may attach an unmatched source or target to an existing
  // residual component, allowing legitimate split/merge completion.
  let relatedSources = new Set(relationships.map((r) => r.source));
  let relatedTargets = new Set(relationships.map((r) => r.target));
  for (const source of sources) {
    if (lockedSources.has(source.id) || relatedSources.has(source.id)) continue;
    for (const target of targets) {
      if (lockedTargets.has(target.id)) continue;
      if (!sameCounty(source.id, target.id)) continue;
      if (
        containsRepresentativePoint(source.feature, target.feature) ||
        containsRepresentativePoint(target.feature, source.feature)
      ) {
        relationships.push(containmentRecord(source.id, target.id));
      }
    }
  }
  relatedSources = new Set(relationships.map((r) => r.source));
  relatedTargets = new Set(relationships.map((r) => r.target));
  for (const target of targets) {
    if (lockedTargets.has(target.id) || relatedTargets.has(target.id)) continue;
    for (const source of sources) {
      if (lockedSources.has(source.id)) continue;
      if (!sameCounty(source.id, target.id)) continue;
      if (
        containsRepresentativePoint(source.feature, target.feature) ||
        containsRepresentativePoint(target.feature, source.feature)
      ) {
        relationships.push(containmentRecord(source.id, target.id));
      }
    }
  }

  const clean = dedupe(relationships);
  const finalSources = new Set(clean.map((r) => r.source));
  const finalTargets = new Set(clean.map((r) => r.target));
  for (const source of sources)
    if (!finalSources.has(source.id))
      diagnostics.push({ source: source.id, reason: "unmatched-source" });
  for (const target of targets)
    if (!finalTargets.has(target.id))
      diagnostics.push({ target: target.id, reason: "unmatched-target" });

  return {
    relationships: clean,
    diagnostics,
    intersectionErrors,
    intersectionErrorSamples,
    exactGeoidMatches: lockedSources.size,
    containmentRescues: clean.filter((r) => r.method === "containment").length,
  };

  function recordIntersectionError(source, target, message) {
    intersectionErrors += 1;
    if (intersectionErrorSamples.length < 5)
      intersectionErrorSamples.push({ source, target, message });
  }
}

function containmentRecord(source, target) {
  return {
    source,
    target,
    intersectionArea: 0,
    sourceShare: 0,
    targetShare: 0,
    sameGeoid: false,
    sameCounty: true,
    stableVerified: false,
    method: "containment",
    forced: false,
  };
}

function prep(feature) {
  const id = String(feature?.properties?.__pc_geoid || "");
  const normalized = normalizeGeometry(feature);
  const area = normalized ? safeArea(normalized) : 0;
  const box = normalized ? safeBbox(normalized) : null;
  return id && normalized && area > 0 && box ? { feature: normalized, id, area, box } : null;
}

function normalizeGeometry(feature) {
  try {
    if (!feature?.geometry) return null;
    // Turf cleanCoords removes redundant coordinates that commonly break overlays.
    const cleaned = turf.cleanCoords(feature, { mutate: false });
    if (cleaned.geometry.type === "Polygon" || cleaned.geometry.type === "MultiPolygon")
      return cleaned;
    return null;
  } catch (_) {
    return feature;
  }
}

function overlapEvidence(source, target) {
  // Primary: Turf polygon intersection.
  try {
    const result = turf.intersect(source.feature, target.feature);
    return { area: result ? safeArea(result) : 0, error: false, message: "" };
  } catch (firstError) {
    // Geometry-safe fallback: unkink each side, intersect valid polygon pieces, and sum.
    try {
      const sourceParts = polygonParts(source.feature);
      const targetParts = polygonParts(target.feature);
      let area = 0;
      for (const a of sourceParts)
        for (const b of targetParts) {
          try {
            const result = turf.intersect(a, b);
            if (result) area += safeArea(result);
          } catch (_) {
            /* a bad piece should not invalidate other valid pieces */
          }
        }
      if (area > 0) return { area, error: false, message: "recovered-with-polygon-parts" };
      // If overlay remains unavailable, representative-point containment still proves overlap.
      if (
        containsRepresentativePoint(source.feature, target.feature) ||
        containsRepresentativePoint(target.feature, source.feature)
      ) {
        const conservativeArea = Math.min(source.area, target.area);
        return { area: conservativeArea, error: false, message: "recovered-with-containment" };
      }
      return { area: 0, error: true, message: String(firstError?.message || firstError) };
    } catch (fallbackError) {
      return { area: 0, error: true, message: String(fallbackError?.message || fallbackError) };
    }
  }
}

function polygonParts(feature) {
  try {
    if (feature.geometry.type === "Polygon")
      return turf.unkinkPolygon(feature).features || [feature];
    const parts = [];
    for (const coordinates of feature.geometry.coordinates || []) {
      const polygon = turf.polygon(coordinates);
      parts.push(...(turf.unkinkPolygon(polygon).features || [polygon]));
    }
    return parts.length ? parts : [feature];
  } catch (_) {
    return [feature];
  }
}

function containsRepresentativePoint(pointSource, polygon) {
  try {
    return turf.booleanPointInPolygon(turf.pointOnFeature(pointSource), polygon);
  } catch (_) {
    return false;
  }
}
function dedupe(records) {
  const byKey = new Map();
  for (const record of records) {
    const key = `${record.source}|${record.target}`;
    const current = byKey.get(key);
    if (!current || record.intersectionArea > current.intersectionArea) byKey.set(key, record);
  }
  return [...byKey.values()];
}
function sameCounty(a, b) {
  return a.slice(0, 5) === b.slice(0, 5);
}
function bboxTouches(a, b) {
  return a && b && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
function safeArea(feature) {
  try {
    const n = turf.area(feature);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}
function safeBbox(feature) {
  try {
    return turf.bbox(feature);
  } catch (_) {
    return null;
  }
}
