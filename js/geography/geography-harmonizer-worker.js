/**
 * LATS-style relationship resolver.
 *
 * Pass 1: exact GEOID continuity. Exact matches are locked one-to-one and are not reused.
 * Pass 2: unmatched features are related by same-county polygon intersection. Intersection
 *         percentages are QA evidence only and never value-allocation weights.
 * Pass 3: remaining unmatched features receive a relationship only when reciprocal/simple
 *         point-on-surface containment supplies geographic evidence.
 *
 * No candidate scoring, GEOID renumbering, area weighting, or proximity-based assignment.
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
  const sliverThreshold = Number(options.sliverThreshold) || 0.0001; // 0.01%
  const relationships = [];
  const diagnostics = [];
  let intersectionErrors = 0;

  const sources = sourceFeatures.map(prepFeature).filter(Boolean);
  const targets = targetFeatures.map(prepFeature).filter(Boolean);
  const sourceById = new Map(sources.map((item) => [item.id, item]));
  const targetById = new Map(targets.map((item) => [item.id, item]));
  const lockedSources = new Set();
  const lockedTargets = new Set();

  // Pass 1: exact GEOID continuity. This is intentionally the primary LATS-style match.
  for (const [id, source] of sourceById) {
    const target = targetById.get(id);
    if (!target) continue;
    relationships.push(makeExactRelationship(source, target));
    lockedSources.add(id);
    lockedTargets.add(id);
  }

  // Pass 2: geography only for GEOIDs that did not continue directly.
  for (const source of sources) {
    if (lockedSources.has(source.id)) continue;
    for (const target of targets) {
      if (lockedTargets.has(target.id)) continue;
      if (!sameCounty(source.id, target.id) || !bboxTouches(source.box, target.box)) continue;

      const intersection = safeIntersection(source.feature, target.feature);
      if (intersection.error) {
        intersectionErrors += 1;
        continue;
      }
      if (intersection.area <= 0) continue;

      const sourceShare = intersection.area / source.area;
      const targetShare = intersection.area / target.area;
      if (sourceShare < sliverThreshold && targetShare < sliverThreshold) continue;

      relationships.push({
        source: source.id,
        target: target.id,
        intersectionArea: intersection.area,
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

  // Pass 3: containment rescue for features still absent from any temporal relationship.
  const relatedSources = new Set(relationships.map((record) => record.source));
  const relatedTargets = new Set(relationships.map((record) => record.target));

  for (const source of sources) {
    if (relatedSources.has(source.id)) continue;
    const candidates = [];
    for (const target of targets) {
      if (relatedTargets.has(target.id)) continue;
      if (!sameCounty(source.id, target.id)) continue;
      const sourceInTarget = pointInside(source.feature, target.feature);
      const targetInSource = pointInside(target.feature, source.feature);
      if (sourceInTarget || targetInSource) {
        candidates.push({ target, sourceInTarget, targetInSource });
      }
    }

    // Only auto-rescue an unambiguous containment relationship.
    if (candidates.length === 1) {
      const { target, sourceInTarget, targetInSource } = candidates[0];
      relationships.push({
        source: source.id,
        target: target.id,
        intersectionArea: 0,
        sourceShare: 0,
        targetShare: 0,
        sameGeoid: false,
        sameCounty: true,
        stableVerified: false,
        method: sourceInTarget && targetInSource ? "reciprocal-containment" : "containment-rescue",
        forced: false,
      });
      relatedSources.add(source.id);
      relatedTargets.add(target.id);
    }
  }

  const finalSources = new Set(relationships.map((record) => record.source));
  const finalTargets = new Set(relationships.map((record) => record.target));
  for (const source of sources) {
    if (!finalSources.has(source.id))
      diagnostics.push({ source: source.id, reason: "unmatched-source" });
  }
  for (const target of targets) {
    if (!finalTargets.has(target.id))
      diagnostics.push({ target: target.id, reason: "unmatched-target" });
  }

  return {
    relationships: dedupeRelationships(relationships),
    diagnostics,
    intersectionErrors,
    exactGeoidMatches: lockedSources.size,
    containmentRescues: relationships.filter((record) => record.method.includes("containment"))
      .length,
    forcedNearest: 0,
  };
}

function prepFeature(feature) {
  const id = String(feature?.properties?.__pc_geoid || "");
  const area = safeArea(feature);
  const box = safeBbox(feature);
  return id && area > 0 && box ? { feature, id, area, box } : null;
}

function makeExactRelationship(source, target) {
  let intersectionArea = 0;
  const intersection = safeIntersection(source.feature, target.feature);
  if (!intersection.error) intersectionArea = intersection.area;
  return {
    source: source.id,
    target: target.id,
    intersectionArea,
    sourceShare: intersectionArea / source.area,
    targetShare: intersectionArea / target.area,
    sameGeoid: true,
    sameCounty: true,
    stableVerified: true,
    method: "exact-geoid",
    forced: false,
  };
}

function dedupeRelationships(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = `${record.source}|${record.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameCounty(sourceId, targetId) {
  return sourceId.slice(0, 5) === targetId.slice(0, 5);
}

function safeArea(feature) {
  try {
    const area = turf.area(feature);
    return Number.isFinite(area) && area > 0 ? area : 0;
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

function bboxTouches(a, b) {
  return a && b && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function safeIntersection(a, b) {
  try {
    const intersection = turf.intersect(a, b);
    return { area: intersection ? safeArea(intersection) : 0, error: false };
  } catch (_) {
    return { area: 0, error: true };
  }
}

function pointInside(pointFeature, polygonFeature) {
  try {
    const point = turf.pointOnFeature(pointFeature);
    return turf.booleanPointInPolygon(point, polygonFeature);
  } catch (_) {
    return false;
  }
}
