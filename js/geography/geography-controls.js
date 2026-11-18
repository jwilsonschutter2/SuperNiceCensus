/**
 * Geography form controls and dependent county loading behavior.
 * Auto-extracted from the original scripts.js to improve maintainability.
 */

function populateStateDropdown() {
  const s = $("stateSelect");
  STATE_FIPS.forEach((st) => {
    const o = document.createElement("option");
    o.value = st.fips;
    o.textContent = `${st.name} (${st.fips})`;
    s.appendChild(o);
  });
}

function handleGeoLevelChange() {
  geoLevel = this.value;
  $("stateOptions").style.display = [
    "state",
    "county",
    "tract",
    "blockgroup",
  ].includes(geoLevel)
    ? "block"
    : "none";
  $("countyOptions").style.display = ["county", "tract", "blockgroup"].includes(
    geoLevel,
  )
    ? "block"
    : "none";
  $("tractOptions").style.display = geoLevel === "tract" ? "block" : "none";
  $("blockGroupOptions").style.display =
    geoLevel === "blockgroup" ? "block" : "none";
  scheduleAvailabilityCheck();
}

async function handleStateSelectChange() {
  selectedState = this.value;
  $("stateInput").value = selectedState;
  selectedCounty = "";
  selectedCounties = [];
  $("countyInput").value = "";
  resetCountyDropdown("-- Loading Counties --");
  syncState();
  if (!selectedState || selectedState === "*") {
    resetCountyDropdown("-- Select State First --");
    scheduleAvailabilityCheck();
    return;
  }
  await loadCountiesForSelectedState();
  scheduleAvailabilityCheck();
}

function selectedCountyFips() { return [...selectedCounties]; }
window.PrettyCensusSelectedCounties = selectedCountyFips;

function handleCountySelectChange() { syncCounty(); }
function updateCountySelection() {
  selectedCounties = [...document.querySelectorAll('.county-check:checked')].map(x=>x.value);
  selectedCounty = selectedCounties[0] || "";
  $("countySelect").innerHTML = selectedCounty ? `<option value="${selectedCounty}" selected>${selectedCounty}</option>` : '<option value=""></option>';
  $("countyInput").value = selectedCounties.join(", ");
  const names=[...document.querySelectorAll('.county-check:checked')].map(x=>x.dataset.name);
  $("countySelectionSummary").textContent = selectedCounties.length ? `${selectedCounties.length} selected: ${names.join(', ')}` : '0 counties selected';
  if (selectedCounties.length) { $("allTractsCheckbox").checked=true; $("allBlockGroupsCheckbox").checked=true; selectedTract="*"; selectedBlockGroup="*"; }
  syncTract(); syncBlockGroup(); scheduleAvailabilityCheck();
}
function syncState() { selectedState=$("stateSelect").value; $("stateSelect").disabled=false; $("stateInput").value=selectedState; }
function syncCounty() { updateCountySelection(); }
function syncTract() { selectedTract=$("allTractsCheckbox").checked?"*":digitsOnly($("tractInput").value).slice(0,6); $("tractInput").disabled=$("allTractsCheckbox").checked; }
function syncBlockGroup() { selectedBlockGroup=$("allBlockGroupsCheckbox").checked?"*":digitsOnly($("blockGroupInput").value).slice(0,1); $("blockGroupInput").disabled=$("allBlockGroupsCheckbox").checked; }
function resetCountyDropdown(label) {
  $("countySelect").innerHTML=`<option value="">${label}</option>`;
  $("countyCheckboxes").innerHTML=""; $("countySearch").disabled=true; $("countySelectAll").disabled=true; $("countyClearAll").disabled=true;
  $("countySelectionSummary").textContent='0 counties selected';
}
async function reloadCountiesIfStateSelected(){ if(selectedState&&selectedState!=="*"&&["county","tract","blockgroup"].includes(geoLevel)) await loadCountiesForSelectedState(); }
async function loadCountiesForSelectedState(){
 try{
  $("countyStatus").textContent="Loading counties...";
  const counties=await loadCountyFipsFromCensus({year:selectedYear||"2024",dataset:selectedDataset||"acs/acs5",stateFips:selectedState,apiKey});
  $("countyCheckboxes").innerHTML=counties.map(co=>`<label class="county-option"><input class="county-check" type="checkbox" value="${co.fips}" data-name="${escapeHtml(co.name)}"> <span>${escapeHtml(co.name)} (${co.fips})</span></label>`).join('');
  $("countySearch").disabled=false; $("countySelectAll").disabled=false; $("countyClearAll").disabled=false;
  document.querySelectorAll('.county-check').forEach(x=>x.addEventListener('change',updateCountySelection));
  $("countySearch").oninput=e=>{const q=e.target.value.toLowerCase();document.querySelectorAll('.county-option').forEach(x=>x.hidden=!x.textContent.toLowerCase().includes(q));};
  $("countySelectAll").onclick=()=>{document.querySelectorAll('.county-option:not([hidden]) .county-check').forEach(x=>x.checked=true);updateCountySelection();};
  $("countyClearAll").onclick=()=>{document.querySelectorAll('.county-check').forEach(x=>x.checked=false);updateCountySelection();};
  $("countyStatus").textContent=`Loaded ${counties.length} counties for ${getStateNameFromFips(selectedState)}.`;
 }catch(e){resetCountyDropdown('-- County Lookup Failed --');$("countyStatus").textContent="Could not load counties for this year/dataset.";}
}
