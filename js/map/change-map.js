/** Create Change Map with normalized many-to-many relationship export and automatic extent fitting. */
(function () {
  "use strict";
  const el = (id) => document.getElementById(id);
  const SOURCE = "pc-change";
  const WEIGHT_TOLERANCE = 1e-6;
  let map = null,
    geojson = null,
    relationshipRows = [];

  function status(text, kind = "muted") {
    el("changeMapStatus").textContent = text;
    el("changeMapStatus").className = `map-status ${kind}`;
  }
  function populate() {
    const select = el("changeMapVariable"),
      previous = select.value;
    select.innerHTML = '<option value="">-- Select variable --</option>';
    const ids = [];
    (selectedTables || []).forEach((id) => { if (id && !ids.includes(id)) ids.push(id); });
    const raw = el("tableInput")?.value || "";
    raw.split(/[\s,;]+/).map(v => v.trim()).filter(Boolean).forEach(id => { if (!ids.includes(id)) ids.push(id); });
    ids.forEach((id) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = tableFriendlyNames[id] ? `${tableFriendlyNames[id]} (${id})` : id;
      select.append(option);
    });
    if (ids.includes(previous)) select.value = previous;
    else if (ids.length === 1) select.value = ids[0];
    select.disabled = ids.length === 0;
  }
  window.populateChangeMapVariables = populate;
  document.addEventListener("change", (ev) => { if (ev.target?.matches?.("#tableInput, input[type=checkbox], #mappingOption")) setTimeout(populate, 0); });
  document.addEventListener("input", (ev) => { if (ev.target?.id === "tableInput") populate(); });

  async function rows(year, variable) {
    if (typeof fetchTopicRowsForCounties === "function") return fetchTopicRowsForCounties(year, variable, (i,n)=>status(`Loading ${year}: county ${i} of ${n}...`,"checking"));
    const response = await fetch(buildSingleTopicUrl(year, variable));
    if (!response.ok) throw Error(`Census request for ${year} failed (${response.status}).`);
    return apiArrayToObjects(await response.json());
  }
  function tag(collection, level) {
    collection.features.forEach((feature) => {
      feature.properties = {
        ...(feature.properties || {}),
        __pc_geoid: String(PrettyCensusGeoid.fromFeature(feature, level) || ""),
      };
    });
  }
  function options() {
    return { stableThreshold: 0.99, minIntersectionArea: 0 };
  }
  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  function inferredArea(intersection, share) {
    const a = finite(intersection),
      s = finite(share);
    return a !== null && s !== null && s > 0 ? a / s : null;
  }
  function featureIds(collection, level) {
    return new Set(
      (collection.features || [])
        .map((feature) =>
          String(
            feature.properties?.__pc_geoid ||
              PrettyCensusGeoid.fromFeature(feature, level) ||
              "",
          ),
        )
        .filter(Boolean),
    );
  }
  function cardinality(records) {
    const sourceTargets = new Map(),
      targetSources = new Map();
    records.forEach((record) => {
      if (!sourceTargets.has(record.source))
        sourceTargets.set(record.source, new Set());
      if (!targetSources.has(record.target))
        targetSources.set(record.target, new Set());
      sourceTargets.get(record.source).add(record.target);
      targetSources.get(record.target).add(record.source);
    });
    return { sourceTargets, targetSources };
  }
  function relationshipType(source, target, index) {
    const targetCount = index.sourceTargets.get(source)?.size || 0;
    const sourceCount = index.targetSources.get(target)?.size || 0;
    if (targetCount === 1 && sourceCount === 1) return "one_to_one";
    if (targetCount > 1 && sourceCount === 1) return "one_to_many";
    if (targetCount === 1 && sourceCount > 1) return "many_to_one";
    if (targetCount > 1 && sourceCount > 1) return "many_to_many";
    return "unclassified";
  }
  function validateAndNormalize(
    records,
    sourceGeo,
    targetGeo,
    sourceYear,
    targetYear,
    level,
  ) {
    const sourceIds = featureIds(sourceGeo, level),
      targetIds = featureIds(targetGeo, level);
    const unique = new Map();
    const duplicatePairs = [];
    records.forEach((record) => {
      const source = String(record.source ?? "");
      const target = String(record.target ?? "");
      const key = `${source}\u0000${target}`;
      if (unique.has(key)) {
        duplicatePairs.push(key);
        return;
      }
      unique.set(key, { ...record, source, target });
    });
    const kept = [...unique.values()],
      index = cardinality(kept);
    const sourceWeightTotals = new Map();
    kept.forEach((record) =>
      sourceWeightTotals.set(
        record.source,
        (sourceWeightTotals.get(record.source) || 0) +
          (finite(record.normalizedWeight) ?? finite(record.sourceShare) ?? 0),
      ),
    );
    const badWeightSources = new Set(
      [...sourceWeightTotals]
        .filter(([, total]) => Math.abs(total - 1) > WEIGHT_TOLERANCE)
        .map(([id]) => id),
    );
    const normalized = kept.map((record) => {
      const weight =
        finite(record.normalizedWeight) ?? finite(record.sourceShare);
      const intersection = finite(record.intersectionArea);
      const sourceShare = finite(record.sourceShare);
      const targetShare = finite(record.targetShare);
      const warnings = [];
      if (!record.source || !record.target) warnings.push("missing GEOID");
      if (weight === null) warnings.push("invalid allocation weight");
      if (badWeightSources.has(record.source))
        warnings.push(
          `source weights total ${sourceWeightTotals.get(record.source)}`,
        );
      const values = [intersection, sourceShare, targetShare, weight].filter(
        (value) => value !== null,
      );
      if (values.some((value) => !Number.isFinite(value)))
        warnings.push("non-finite numeric value");
      return {
        source_geoid: record.source,
        target_geoid: record.target,
        source_year: String(sourceYear),
        target_year: String(targetYear),
        geography_type: level,
        source_area: inferredArea(intersection, sourceShare),
        intersection_area: intersection,
        source_overlap_percent: sourceShare === null ? null : sourceShare * 100,
        target_area: inferredArea(intersection, targetShare),
        target_overlap_percent: targetShare === null ? null : targetShare * 100,
        relationship_type: relationshipType(
          record.source,
          record.target,
          index,
        ),
        match_method: String(record.method || ""),
        allocation_weight: weight,
        allocation_weight_direction:
          "share of source value allocated to target",
        validation_status: warnings.length ? "warning" : "valid",
        validation_message: warnings.join("; "),
      };
    });
    for (const source of sourceIds) {
      if (!index.sourceTargets.has(source))
        normalized.push({
          source_geoid: source,
          target_geoid: "",
          source_year: String(sourceYear),
          target_year: String(targetYear),
          geography_type: level,
          source_area: null,
          intersection_area: null,
          source_overlap_percent: null,
          target_area: null,
          target_overlap_percent: null,
          relationship_type: "unmatched_source",
          match_method: "none",
          allocation_weight: null,
          allocation_weight_direction:
            "share of source value allocated to target",
          validation_status: "warning",
          validation_message: "No qualifying target relationship",
        });
    }
    for (const target of targetIds) {
      if (!index.targetSources.has(target))
        normalized.push({
          source_geoid: "",
          target_geoid: target,
          source_year: String(sourceYear),
          target_year: String(targetYear),
          geography_type: level,
          source_area: null,
          intersection_area: null,
          source_overlap_percent: null,
          target_area: null,
          target_overlap_percent: null,
          relationship_type: "unmatched_target",
          match_method: "none",
          allocation_weight: null,
          allocation_weight_direction:
            "share of source value allocated to target",
          validation_status: "warning",
          validation_message: "No qualifying source relationship",
        });
    }
    normalized.sort(
      (a, b) =>
        a.source_geoid.localeCompare(b.source_geoid) ||
        a.target_geoid.localeCompare(b.target_geoid),
    );
    const uniqueSources = new Set(
      normalized.map((r) => r.source_geoid).filter(Boolean),
    );
    const uniqueTargets = new Set(
      normalized.map((r) => r.target_geoid).filter(Boolean),
    );
    const oneToManySources = new Set(
      normalized
        .filter(
          (r) =>
            r.relationship_type === "one_to_many" ||
            r.relationship_type === "many_to_many",
        )
        .map((r) => r.source_geoid),
    );
    const manyToOneTargets = new Set(
      normalized
        .filter(
          (r) =>
            r.relationship_type === "many_to_one" ||
            r.relationship_type === "many_to_many",
        )
        .map((r) => r.target_geoid),
    );
    const summary = {
      rows: normalized.length,
      uniqueSources: uniqueSources.size,
      uniqueTargets: uniqueTargets.size,
      oneToOne: normalized.filter((r) => r.relationship_type === "one_to_one")
        .length,
      splits: oneToManySources.size,
      merges: manyToOneTargets.size,
      manyToMany: normalized.filter(
        (r) => r.relationship_type === "many_to_many",
      ).length,
      unmatchedSources: normalized.filter(
        (r) => r.relationship_type === "unmatched_source",
      ).length,
      unmatchedTargets: normalized.filter(
        (r) => r.relationship_type === "unmatched_target",
      ).length,
      warnings: normalized.filter((r) => r.validation_status !== "valid")
        .length,
      duplicates: duplicatePairs.length,
      badWeightSources: badWeightSources.size,
    };
    console.info("PrettyCensus relationship validation", {
      summary,
      sourceWeightTotals: Object.fromEntries(sourceWeightTotals),
      duplicatePairs,
    });
    return { rows: normalized, summary };
  }
  function showQa(summary) {
    const pass = summary.conservationPassed ? "PASS" : "FAIL";
    el("changeMapQa").innerHTML = `<strong>Geography-Normalized Change QA</strong><br>Stable: ${summary.stable}; splits: ${summary.splits}; merges: ${summary.merges}; complex: ${summary.complex}; unresolved: ${summary.unresolved}.<br>Earlier original total: ${fmt(summary.originalTotal)}; reconstructed earlier total: ${fmt(summary.reconstructedTotal)}; difference: ${fmt(summary.conservationDifference)} (${formatPercentChange(summary.conservationPercent)}); conservation: <strong>${pass}</strong>.<br>Later original total: ${fmt(summary.laterOriginalTotal)}. Later observations were not modified.`;
  }
  function validBounds(collection) {
    const bounds = new mapboxgl.LngLatBounds();
    let points = 0;
    function visit(value) {
      if (!Array.isArray(value)) return;
      if (
        value.length >= 2 &&
        Number.isFinite(Number(value[0])) &&
        Number.isFinite(Number(value[1]))
      ) {
        bounds.extend([Number(value[0]), Number(value[1])]);
        points++;
        return;
      }
      value.forEach(visit);
    }
    (collection.features || []).forEach((feature) => {
      if (
        feature?.geometry &&
        ["Polygon", "MultiPolygon"].includes(feature.geometry.type)
      )
        visit(feature.geometry.coordinates);
    });
    return points ? bounds : null;
  }
  function fitToResults(collection) {
    const bounds = validBounds(collection);
    if (!bounds) {
      status(
        "Change map created, but no valid Polygon or MultiPolygon geometry was available for automatic zoom.",
        "error",
      );
      return;
    }
    requestAnimationFrame(() => {
      map.resize();
      map.fitBounds(bounds, {
        padding: { top: 70, right: 70, bottom: 90, left: 70 },
        maxZoom: 13,
        duration: 700,
      });
      map.once("idle", () => {
        map.resize();
        map.fitBounds(bounds, {
          padding: { top: 70, right: 70, bottom: 90, left: 70 },
          maxZoom: 13,
          duration: 0,
        });
      });
    });
  }
  function formatPercentChange(value,statusText){ const n=Number(value); return value==null||!Number.isFinite(n)?(statusText||"N/A"):`${n.toLocaleString(undefined,{maximumFractionDigits:1})}%`; }
  function fmt(value) {
    const number = Number(value);
    return value == null || !Number.isFinite(number)
      ? "No data"
      : number.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  function render(result, field, sourceYear, targetYear, variable, token) {
    mapboxgl.accessToken = token;
    if (!map) {
      map = new mapboxgl.Map({
        container: "prettyCensusChangeMap",
        style: "mapbox://styles/mapbox/light-v11",
        center: [-96, 38],
        zoom: 3,
      });
      map.addControl(new mapboxgl.NavigationControl());
    }
    const draw = () => {
      for (const id of ["pc-change-line", "pc-change-fill"])
        if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SOURCE)) map.removeSource(SOURCE);
      map.addSource(SOURCE, {
        type: "geojson",
        data: result.geojson,
        generateId: true,
      });
      const values = result.geojson.features
        .map((feature) => Math.abs(Number(feature.properties[field]) || 0))
        .sort((a, b) => a - b);
      const limit = values[Math.floor(values.length * 0.95)] || 1;
      map.addLayer({
        id: "pc-change-fill",
        type: "fill",
        source: SOURCE,
        paint: {
          "fill-color": [
            "case",
            ["==", ["get", field], null],
            "rgba(0,0,0,0)",
            [
              "interpolate",
              ["linear"],
              ["to-number", ["get", field]],
              -limit,
              "#b2182b",
              0,
              "#f7f7f7",
              limit,
              "#2166ac",
            ],
          ],
          "fill-opacity": ["case", ["==", ["get", field], null], 0, 0.82],
        },
      });
      map.addLayer({
        id: "pc-change-line",
        type: "line",
        source: SOURCE,
        paint: {
          "line-color": "#fff",
          "line-opacity": ["case", ["==", ["get", field], null], 0, 1],
        },
      });
      map.off(
        "mousemove",
        "pc-change-fill",
        window.__pcChangeMove || (() => {}),
      );
      window.__pcChangeMove = (event) => {
        const p = event.features[0].properties;
        el("changeMapReadout").innerHTML =
          `<strong>Target GEOID:</strong> ${escapeHtml(p.__geoid)}<br><strong>Earlier source GEOID(s):</strong> ${escapeHtml(p.__source_geoids || "None")}<br><strong>Relationship:</strong> ${escapeHtml(p.__relationship)} (${escapeHtml(p.relationship_dimensions || "")})<br><strong>GEOID verification:</strong> ${escapeHtml(p.__geoid_verification || "review")}<br><strong>Allocation:</strong> ${escapeHtml(p.allocation_method || "none")} ${p.allocation_fraction != null ? `(${formatPercentChange(Number(p.allocation_fraction)*100)})` : ""}<br><strong>${sourceYear} original source value(s):</strong> ${escapeHtml(p.__source_values || "No data")}<br><strong>${sourceYear} comparison value:</strong> ${fmt(p.earlier_comparison_value)}<br><strong>${targetYear} original value:</strong> ${fmt(p.later_original_value)}<br><strong>Numeric change:</strong> ${fmt(p.numeric_change)}<br><strong>Percentage change:</strong> ${formatPercentChange(p.percent_change,p.pct_change_status)}<br><strong>Conservation:</strong> ${escapeHtml(p.conservation_status || "not checked")}<br><strong>Warning:</strong> ${escapeHtml(p.quality_warning || "None")}`;
      };
      map.on("mousemove", "pc-change-fill", window.__pcChangeMove);
      fitToResults(result.geojson);
    };
    if (map.isStyleLoaded()) draw();
    else map.once("style.load", draw);
  }
  async function build() {
    relationshipRows = [];
    geojson = null;
    el("exportChangeGeoJson").disabled = true;
    el("exportChangeShapefile").disabled = true;
    el("exportChangeRelationships").disabled = true;
    el("changeMapQa").innerHTML = "";
    const first = +el("changeYear1").value,
      second = +el("changeYear2").value,
      variable = el("changeMapVariable").value,
      field = el("changeMetric").value;
    const token =
      el("changeMapboxToken").value.trim() || el("mapboxToken").value.trim();
    if (!first || !second || first === second || !variable || !token)
      return status(
        "Choose two different years, a variable, and a Mapbox token.",
        "error",
      );
    if (
      !["tract", "blockgroup"].includes(geoLevel) ||
      !selectedState ||
      selectedState === "*" ||
      !(selectedCounties?.length || selectedCounty)
    )
      return status(
        "Select one state, at least one county, and Tract or Block Group.",
        "error",
      );
    const sourceYear = Math.min(first, second),
      targetYear = Math.max(first, second),
      base = { level: geoLevel, state: selectedState, county: (selectedCounties?.[0] || selectedCounty) };
    try {
      status("Building and validating geographic relationships...", "checking");
      const [sourceGeo, targetGeo, sourceRows, targetRows] = await Promise.all([
        PrettyCensusBoundaries.load({ ...base, year: sourceYear }),
        PrettyCensusBoundaries.load({ ...base, year: targetYear }),
        rows(sourceYear, variable),
        rows(targetYear, variable),
      ]);
      PrettyCensusBoundaries.county(sourceGeo, base);
      PrettyCensusBoundaries.county(targetGeo, base);
      tag(sourceGeo, geoLevel);
      tag(targetGeo, geoLevel);
      const result = await PrettyCensusHarmonizer.harmonize({
        sourceGeoJson: sourceGeo,
        targetGeoJson: targetGeo,
        sourceRows,
        targetRows,
        variable,
        level: geoLevel,
        cacheKey: `${sourceYear}|${targetYear}|${selectedState}|${(selectedCounties||[]).join(",")}|${geoLevel}`,
        options: options(),
      });
      const filtered = filterFeatureCollectionToChosenGeography(
        result.geojson,
        geoLevel,
      );
      const included = new Set(
        filtered.features.map((feature) =>
          String(
            feature.properties?.__geoid ||
              PrettyCensusGeoid.fromFeature(feature, geoLevel),
          ),
        ),
      );
      const relevant = result.relationships.filter((record) =>
        included.has(String(record.target)),
      );
      const relevantTarget = {
        ...targetGeo,
        features: targetGeo.features.filter((feature) =>
          included.has(String(feature.properties?.__pc_geoid)),
        ),
      };
      relationshipRows = result.relationships
        .filter((row) => included.has(String(row.target)))
        .map((row) => ({
          source_year: String(sourceYear), target_year: String(targetYear),
          source_geoid: row.source, target_geoid: row.target,
          source_original_value: row.sourceOriginalValue, target_original_value: row.targetOriginalValue,
          relationship_type: row.relationshipType, source_count: row.sourceCount, target_count: row.targetCount,
          allocation_method: row.allocationMethod, allocation_fraction: row.allocationFraction,
          earlier_comparison_value: row.earlierComparisonValue, geographic_correspondence: row.geographicCorrespondence,
          source_overlap_percent: row.sourceShare == null ? null : row.sourceShare * 100,
          target_overlap_percent: row.targetShare == null ? null : row.targetShare * 100,
          geoid_verification: row.geoidVerification, qa_status: row.qaStatus
        }));
      result.geojson = filtered;
      geojson = compactFeatureCollection(filtered, [
        "__geoid",
        "__earlier_harmonized",
        "__later",
        "__difference",
        "__percent",
        "__relationship",
        "__assignment_methods",
        "__confidence",
        "__source_geoids",
        "__source_weights",
        "__observed_coverage",
        "__forced_assignment",
        "__estimated",
        "earlier_value",
        "later_value",
        "numeric_change",
        "percent_change",
        "percent_change_label",
        "pct_change_status",
        "quality_warning",
        "earlier_original_value", "earlier_comparison_value", "later_original_value",
        "relationship_dimensions", "allocation_method", "allocation_fraction",
        "__source_values", "__geoid_verification", "conservation_status",
      ]);
      render(result, field, sourceYear, targetYear, variable, token);
      showQa(result.summary);
      el("exportChangeGeoJson").disabled = false;
      el("exportChangeShapefile").disabled = false;
      el("exportChangeRelationships").disabled = !relationshipRows.length;
      status(
        `Change map created. Conservation ${result.summary.conservationPassed ? "passed" : "failed"}; ${result.summary.unresolved} unresolved component(s).`,
        result.summary.conservationPassed && !result.summary.unresolved ? "success" : "checking",
      );
    } catch (error) {
      console.error(error);
      relationshipRows = [];
      status(error.message || String(error), "error");
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    el("buildChangeMap").addEventListener("click", build);
    el("exportChangeGeoJson").addEventListener(
      "click",
      () => geojson && downloadGeoJson(geojson, prettyCensusFilename("change", el("changeMapVariable").value)),
    );
    el("exportChangeShapefile").addEventListener("click", async () => {
      try {
        if (geojson) await downloadShapefile(geojson, "change-map.zip");
      } catch (error) {
        status(error.message || String(error), "error");
      }
    });
    el("exportChangeRelationships").addEventListener("click", () =>
      relationshipRows.length
        ? exportRowsToCsv(relationshipRows, "change-relationships.csv")
        : status("Build a change map before exporting relationships.", "error"),
    );
    document.addEventListener("change", (event) => {
      if (
        event.target.classList.contains("presetCheckbox") ||
        event.target.id === "tableInput"
      )
        populate();
    });
  });
})();
