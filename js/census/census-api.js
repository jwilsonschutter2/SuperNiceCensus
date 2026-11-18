/**
 * Census API URL construction, fetch, and response normalization helpers.
 * Auto-extracted from the original scripts.js to improve maintainability.
 */

function geoParams(params) {
  if (geoLevel === "state") {
    if (!selectedState) return false;
    params.set("for", `state:${selectedState}`);
  } else if (geoLevel === "county") {
    if (!selectedState || selectedState === "*" || !selectedCounty)
      return false;
    params.set("for", `county:${selectedCounty}`);
    params.set("in", `state:${selectedState}`);
  } else if (geoLevel === "tract") {
    if (
      !selectedState ||
      selectedState === "*" ||
      !selectedCounty ||
      selectedCounty === "*"
    )
      return false;
    params.set("for", `tract:${selectedTract || "*"}`);
    params.set("in", `state:${selectedState} county:${selectedCounty}`);
  } else if (geoLevel === "blockgroup") {
    if (
      !selectedState ||
      selectedState === "*" ||
      !selectedCounty ||
      selectedCounty === "*"
    )
      return false;
    params.set("for", `block group:${selectedBlockGroup || "*"}`);
    params.set(
      "in",
      `state:${selectedState} county:${selectedCounty} tract:${selectedTract || "*"}`,
    );
  } else return false;
  return true;
}

function buildCensusURL(opts = {}) {
  if (
    !apiKey ||
    !selectedYear ||
    !selectedDataset ||
    !selectedTables.length ||
    !geoLevel
  ) {
    alert(
      "Missing required fields: API key, year, dataset, tables, and geography level.",
    );
    return "";
  }
  const p = new URLSearchParams();
  p.set("get", selectedTables.join(","));
  if (!geoParams(p)) {
    alert("Check geography selections.");
    return "";
  }
  if ((opts.outputFormat || "csv") === "csv") p.set("outputFormat", "csv");
  p.set("key", apiKey);
  return `https://api.census.gov/data/${selectedYear}/${selectedDataset}?${p.toString()}`;
}

function buildSingleTopicUrl(year, topic) {
  if (!year || !selectedDataset || !geoLevel) return "";
  const p = new URLSearchParams();
  p.set("get", `NAME,${topic}`);
  if (!geoParams(p)) return "";
  if (apiKey) p.set("key", apiKey);
  return `https://api.census.gov/data/${year}/${selectedDataset}?${p.toString()}`;
}


function activeCounties() { return selectedCounties?.length ? [...selectedCounties] : (selectedCounty ? [selectedCounty] : []); }
function buildSingleTopicUrls(year, topic) {
  const counties=activeCounties();
  if (!counties.length) return [];
  return counties.map(county=>{ const save=selectedCounty; selectedCounty=county; const url=buildSingleTopicUrl(year,topic); selectedCounty=save; return url; }).filter(Boolean);
}
async function fetchTopicRowsForCounties(year, topic, progress) {
 const urls=buildSingleTopicUrls(year,topic), counties=activeCounties(), all=[];
 for(let i=0;i<urls.length;i++){
  if(progress) progress(i+1,urls.length); let data=null,last=null;
  for(let attempt=1;attempt<=3;attempt++){try{const r=await fetch(urls[i],{headers:{Accept:"application/json"}}),text=await r.text();if(!r.ok)throw Error(`HTTP ${r.status}: ${text.slice(0,180)}`);if(!text.trim())throw Error("empty response");data=JSON.parse(text);if(!Array.isArray(data)||!Array.isArray(data[0]))throw Error("unexpected payload");break}catch(e){last=e;if(attempt<3)await new Promise(ok=>setTimeout(ok,300*attempt));}}
  if(!data)throw Error(`Census ${year} request failed for county ${counties[i]} after 3 attempts: ${last?.message||last}`);
  all.push(...apiArrayToObjects(data));
 }
 return [...new Map(all.map(row=>[PrettyCensusGeoid.fromRow(row,geoLevel),row])).values()];
}
async function fetchJsonAndDisplay() {
  const counties=activeCounties(); if(!counties.length){ alert("Select at least one county."); return; }
  try {
    let headers=null, rows=[];
    for(let i=0;i<counties.length;i++){ const save=selectedCounty; selectedCounty=counties[i]; const url=buildCensusURL({outputFormat:"json"}).replace(/&?outputFormat=csv/,""); selectedCounty=save; const r=await fetch(url); if(!r.ok) throw Error(`County ${i+1} of ${counties.length} failed (${r.status}).`); const d=await r.json(); headers=headers||d[0]; rows.push(...d.slice(1)); $("jsonTableContainer").innerHTML=`<p>Loading county ${i+1} of ${counties.length}...</p>`; }
    const unique=[...new Map(rows.map(row=>[headers.map((h,j)=>({h,v:row[j]})).filter(x=>["state","county","tract","block group"].includes(x.h)).map(x=>x.v).join("|"),row])).values()];
    let d=[headers,...unique]; currentFetchedData=d; currentFetchedHeaders=headers; $("jsonTableContainer").innerHTML=convertJSONToTable(d); $("exportCurrentCsvBtn").disabled=false;
  } catch(e){ $("jsonTableContainer").innerHTML=`<p class='error-text'>${escapeHtml(e.message)}</p>`; $("exportCurrentCsvBtn").disabled=true; }
}

function apiArrayToObjects(data) {
  if (!Array.isArray(data) || data.length < 2) return [];
  const [headers, ...rows] = data;
  const geoFields = new Set([
    "NAME",
    "state",
    "county",
    "tract",
    "block group",
  ]);
  return rows.map((row) =>
    Object.fromEntries(
      headers.map((header, index) => {
        const raw = row[index];
        if (
          geoFields.has(header) ||
          raw === null ||
          raw === undefined ||
          raw === ""
        )
          return [header, raw];
        const numeric = Number(raw);
        return [header, Number.isFinite(numeric) && numeric < 0 ? 0 : raw];
      }),
    ),
  );
}
