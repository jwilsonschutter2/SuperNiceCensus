/* Geography-first edge resolver. GEOID is verification/tie-break evidence only.
 * Direct matches are locked before split/merge/complex grouping. */
importScripts("https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js");
self.onmessage=e=>{try{self.postMessage(build(e.data))}catch(x){self.postMessage({error:x.message||String(x)})}};
function build({sourceFeatures=[],targetFeatures=[],options={}}){
 const strong=Number(options.strongCoverage)||.95,minCandidate=Number(options.minCandidateCoverage)||.01,sliver=Number(options.sliverThreshold)||.001,allowCross=!!options.allowCrossCounty;
 const S=sourceFeatures.map(info).filter(x=>x.id),T=targetFeatures.map(info).filter(x=>x.id),candidates=[],rejected=[];
 // Geography first: positive intersection or containment creates candidate. Same GEOID alone never does.
 for(const s of S)for(const t of T){if(!compatible(s,t,allowCross)||!touch(s.box,t.box))continue;const e=edge(s,t,"polygon");const evidence=e.intersectionArea>0||e.sourcePointInTarget||e.targetPointInSource;if(!evidence)continue;if(e.intersectionArea>0&&Math.max(e.sourceShare,e.targetShare)<sliver&&!e.sourcePointInTarget&&!e.targetPointInSource)continue;if(Math.max(e.sourceShare,e.targetShare)>=minCandidate||e.sourcePointInTarget||e.targetPointInSource)candidates.push(e)}
 // Explicitly flag same-GEOID/no-geography conflicts without adding an edge.
 const tById=new Map(T.map(x=>[x.id,x]));for(const s of S){const t=tById.get(s.id);if(t&&!candidates.some(e=>e.source===s.id&&e.target===t.id))rejected.push({source:s.id,target:t.id,reason:"same-geoid-no-geographic-evidence"})}
 // Score and lock exclusive strong direct pairs first.
 candidates.forEach(e=>e.score=.45*e.sourceShare+.45*e.targetShare+.10*e.overlapCoefficient+(e.sameGeoid?.02:0));
 const byS=group(candidates,"source"),byT=group(candidates,"target"),locked=[],usedS=new Set(),usedT=new Set();
 const direct=candidates.filter(e=>e.sourceShare>=strong&&e.targetShare>=strong).sort((a,b)=>b.score-a.score);
 for(const e of direct){if(usedS.has(e.source)||usedT.has(e.target))continue;const sNext=(byS.get(e.source)||[]).filter(x=>x!==e).sort((a,b)=>b.score-a.score)[0],tNext=(byT.get(e.target)||[]).filter(x=>x!==e).sort((a,b)=>b.score-a.score)[0];if((sNext&&e.score-sNext.score<.02)||(tNext&&e.score-tNext.score<.02))continue;e.lockedDirect=true;e.relationshipHint=e.sameGeoid?"stable_same_geoid":"renumbered_direct";locked.push(e);usedS.add(e.source);usedT.add(e.target)}
 // Residual graph only. A locked direct source/target cannot appear elsewhere.
 const residual=candidates.filter(e=>!usedS.has(e.source)&&!usedT.has(e.target));
 // Remove duplicate edges deterministically.
 const edges=[...locked,...new Map(residual.sort((a,b)=>b.score-a.score).map(e=>[`${e.source}|${e.target}`,e])).values()];
 // Diagnostic fallback only, no edge.
 const linkedS=new Set(edges.map(e=>e.source)),linkedT=new Set(edges.map(e=>e.target)),diagnostics=[];
 for(const s of S.filter(x=>!linkedS.has(x.id)))diagnostics.push(nearest(s,T,"source",allowCross));for(const t of T.filter(x=>!linkedT.has(x.id)))diagnostics.push(nearest(t,S,"target",allowCross));
 return{relationships:edges,rejected,diagnostics,sourceBoundaryGeoids:S.map(x=>x.id),targetBoundaryGeoids:T.map(x=>x.id)};
}
function group(a,k){const m=new Map();for(const x of a){if(!m.has(x[k]))m.set(x[k],[]);m.get(x[k]).push(x)}return m}
function info(feature){const id=String(feature?.properties?.__pc_geoid||"");return{feature,id,state:id.slice(0,2),county:id.slice(2,5),area:area(feature),box:bbox(feature),point:point(feature)}}
function edge(s,t,evidenceType){const x=intersection(s.feature,t.feature),i=x.area,ss=s.area?i/s.area:0,ts=t.area?i/t.area:0,oc=Math.min(s.area,t.area)>0?i/Math.min(s.area,t.area):0,u=s.area+t.area-i;return{source:s.id,target:t.id,evidenceType,intersectionArea:i,sourceShare:ss,targetShare:ts,overlapCoefficient:oc,iou:u>0?i/u:0,sameGeoid:s.id===t.id,sameState:s.state===t.state,sameCounty:s.county===t.county,sourcePointInTarget:contains(t.feature,s.point),targetPointInSource:contains(s.feature,t.point)}}
function compatible(a,b,c){return a.state===b.state&&(c||a.county===b.county)}function area(f){try{return turf.area(f)||0}catch(_){return 0}}function bbox(f){try{return turf.bbox(f)}catch(_){return null}}function point(f){try{return turf.pointOnFeature(f)}catch(_){return null}}function contains(f,p){try{return!!p&&turf.booleanPointInPolygon(p,f)}catch(_){return false}}function touch(a,b){return a&&b&&a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1]}function intersection(a,b){try{const f=turf.intersect(a,b);return{area:f?area(f):0}}catch(_){return{area:0}}}
function nearest(x,C,side,cross){let best=null;for(const y of C.filter(z=>compatible(x,z,cross))){let d=Infinity;try{d=x.point?turf.pointToLineDistance(x.point,turf.polygonToLine(y.feature),{units:"kilometers"}):Infinity}catch(_){}if(Number.isFinite(d)&&(!best||d<best.distanceKm))best={geoid:x.id,side,nearestCandidate:y.id,distanceKm:d,reason:"manual-review"}}return best||{geoid:x.id,side,nearestCandidate:null,distanceKm:null,reason:"no-compatible-candidate"}}
