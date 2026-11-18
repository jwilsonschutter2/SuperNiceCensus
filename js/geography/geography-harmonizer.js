/**
 * Change Map value harmonization.
 *
 * Relationship discovery is handled by geography-harmonizer-worker.js. This module only
 * converts each resolved source/target relationship component into comparison values.
 *
 * Rule for additive Census counts:
 *   earlierComparison = sum(all earlier values in the component) / targetCount
 *
 * This single rule covers 1->1, 1->N, N->1, and N->M relationships without area weighting.
 */
window.PRETTYCENSUS_CHANGE_BUILD = "2026-11-18-clean-simplified-allocation";

window.PrettyCensusHarmonizer = (() => {
  "use strict";

  const cache = new Map();

  function toNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : null;
  }

  function sum(values) {
    return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
  }

  function runWorker(input) {
    return new Promise((resolve, reject) => {
      const worker = new Worker("js/geography/geography-harmonizer-worker.js");
      worker.onmessage = (event) => {
        worker.terminate();
        event.data.error ? reject(Error(event.data.error)) : resolve(event.data);
      };
      worker.onerror = (event) => {
        worker.terminate();
        reject(Error(event.message || "Relationship worker failed."));
      };
      worker.postMessage({
        sourceFeatures: input.sourceGeoJson.features,
        targetFeatures: input.targetGeoJson.features,
        level: input.level,
        options: input.options,
      });
    });
  }

  async function getRelationships(input) {
    const key = `${input.cacheKey}|${JSON.stringify(input.options || {})}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        runWorker(input).catch((error) => {
          cache.delete(key);
          throw error;
        }),
      );
    }
    return cache.get(key);
  }

  function connectedComponents(records) {
    const adjacency = new Map();
    const connect = (left, right) => {
      if (!adjacency.has(left)) adjacency.set(left, new Set());
      adjacency.get(left).add(right);
    };

    records.forEach((record) => {
      connect(`s:${record.source}`, `t:${record.target}`);
      connect(`t:${record.target}`, `s:${record.source}`);
    });

    const components = [];
    const visited = new Set();

    for (const node of adjacency.keys()) {
      if (visited.has(node)) continue;
      const stack = [node];
      const sources = new Set();
      const targets = new Set();
      visited.add(node);

      while (stack.length) {
        const current = stack.pop();
        (current.startsWith("s:") ? sources : targets).add(current.slice(2));
        for (const neighbor of adjacency.get(current) || []) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            stack.push(neighbor);
          }
        }
      }

      components.push({
        sources,
        targets,
        records: records.filter(
          (record) => sources.has(record.source) && targets.has(record.target),
        ),
      });
    }

    return components;
  }

  function relationshipType(component) {
    const sourceCount = component.sources.size;
    const targetCount = component.targets.size;
    if (sourceCount === 1 && targetCount === 1) {
      return component.records.some((record) => record.stableVerified) ? "stable" : "direct";
    }
    if (sourceCount === 1 && targetCount > 1) return "split";
    if (sourceCount > 1 && targetCount === 1) return "merge";
    if (sourceCount > 1 && targetCount > 1) return "complex";
    return "unresolved";
  }

  async function harmonize(input) {
    const data = await getRelationships(input);
    const records = data.relationships;
    const sourceValues = new Map(
      input.sourceRows.map((row) => [
        PrettyCensusGeoid.fromRow(row, input.level),
        toNumber(row[input.variable]),
      ]),
    );
    const targetValues = new Map(
      input.targetRows.map((row) => [
        PrettyCensusGeoid.fromRow(row, input.level),
        toNumber(row[input.variable]),
      ]),
    );

    const comparisonValues = new Map();
    const provenance = new Map();
    const relationshipRows = [];
    const summary = {
      stable: 0,
      direct: 0,
      splits: 0,
      merges: 0,
      complex: 0,
      unresolved: 0,
      sourceObservationCount: sourceValues.size,
      targetObservationCount: targetValues.size,
      matchedSourceCount: 0,
      matchedTargetCount: 0,
      intersectionErrors: data.intersectionErrors || 0,
      exactGeoidMatches: data.exactGeoidMatches || 0,
      containmentRescues: data.containmentRescues || 0,
      intersectionErrorSamples: data.intersectionErrorSamples || [],
    };

    const matchedSources = new Set();
    const matchedTargets = new Set();

    for (const component of connectedComponents(records)) {
      const type = relationshipType(component);
      const sourceIds = [...component.sources];
      const targetIds = [...component.targets];
      const sourceOriginalValues = sourceIds.map((id) => sourceValues.get(id));
      const valid = sourceOriginalValues.every(Number.isFinite);
      const sourceTotal = valid ? sum(sourceOriginalValues) : null;
      const targetCount = targetIds.length;
      const comparison =
        type === "unresolved" || sourceTotal === null || targetCount === 0
          ? null
          : sourceTotal / targetCount;
      const allocationFraction = comparison === null ? null : 1 / targetCount;
      const allocationMethod = comparison === null ? "none" : "sum-earlier-divide-by-target-count";

      if (type === "stable") summary.stable += 1;
      else if (type === "direct") summary.direct += 1;
      else if (type === "split") summary.splits += 1;
      else if (type === "merge") summary.merges += 1;
      else if (type === "complex") summary.complex += 1;
      else summary.unresolved += 1;

      sourceIds.forEach((id) => matchedSources.add(id));
      targetIds.forEach((id) => matchedTargets.add(id));

      for (const target of targetIds) {
        if (comparison !== null) comparisonValues.set(target, comparison);
        provenance.set(target, {
          type,
          sourceIds,
          targetIds,
          sourceOriginalValues,
          sourceTotal,
          allocationMethod,
          allocationFraction,
          records: component.records,
        });

        for (const source of sourceIds) {
          const record = component.records.find(
            (candidate) => candidate.source === source && candidate.target === target,
          );
          if (!record) continue;
          relationshipRows.push({
            source,
            target,
            sourceOriginalValue: sourceValues.get(source),
            targetOriginalValue: targetValues.get(target),
            relationshipType: type,
            sourceCount: sourceIds.length,
            targetCount: targetIds.length,
            allocationMethod,
            allocationFraction,
            earlierComparisonValue: comparison,
            geographicCorrespondence: Math.min(record.sourceShare, record.targetShare),
            geoidVerification: record.sameGeoid
              ? "identical"
              : record.sameCounty
                ? "changed-compatible"
                : "cross-county-mismatch",
            qaStatus: type === "unresolved" ? "warning" : "valid",
            intersectionArea: record.intersectionArea,
            sourceShare: record.sourceShare,
            targetShare: record.targetShare,
          });
        }
      }
    }

    summary.matchedSourceCount = matchedSources.size;
    summary.matchedTargetCount = matchedTargets.size;
    summary.unmatchedSourceCount = sourceValues.size - matchedSources.size;
    summary.unmatchedTargetCount = targetValues.size - matchedTargets.size;

    input.targetGeoJson.features.forEach((feature, index) => {
      const id = PrettyCensusGeoid.fromFeature(feature, input.level);
      const info = provenance.get(id);
      const earlier = comparisonValues.get(id) ?? null;
      const later = targetValues.get(id) ?? null;
      const difference = earlier !== null && later !== null ? later - earlier : null;
      const percent = difference !== null && earlier !== 0 ? (difference / earlier) * 100 : null;
      const status =
        earlier === null || later === null
          ? "Missing data"
          : earlier === 0
            ? "Zero baseline"
            : "Valid";

      feature.id = index;
      feature.properties = {
        ...(feature.properties || {}),
        __geoid: id,
        __earlier_harmonized: earlier,
        __later: later,
        __difference: difference,
        __percent: percent,
        earlier_original_value: info?.sourceOriginalValues?.join("|") || null,
        earlier_comparison_value: earlier,
        later_original_value: later,
        numeric_change: difference,
        percent_change: percent,
        percent_change_label: percent === null ? "N/A" : `${percent.toFixed(1)}%`,
        pct_change_status: status,
        __relationship: info?.type || "unresolved",
        relationship_dimensions: info
          ? `${info.sourceIds.length}->${info.targetIds.length}`
          : "0->1",
        allocation_method: info?.allocationMethod || "none",
        allocation_fraction: info?.allocationFraction ?? null,
        __source_geoids: info?.sourceIds.join("|") || "",
        __source_values: info?.sourceOriginalValues.join("|") || "",
        __geoid_verification: info?.records.every((record) => record.sameGeoid)
          ? "identical"
          : info?.records.every((record) => record.sameCounty)
            ? "changed-compatible"
            : "review",
        __observed_coverage: info
          ? Math.min(
              ...info.records.map((record) => Math.min(record.sourceShare, record.targetShare)),
            )
          : 0,
        quality_warning: info?.type === "unresolved" ? "Unresolved geographic relationship" : "",
      };
    });

    return { geojson: input.targetGeoJson, relationships: relationshipRows, summary };
  }

  return { harmonize };
})();
