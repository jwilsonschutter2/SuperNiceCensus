/* Multi-pass completeness-first spatial evidence worker.
 * Each feature receives evidence or an explicit lifecycle disposition. */
importScripts("https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js");
self.onmessage=e=>{try{self.postMessage(build(e.data))}catch(x){self.postMessage({error:x.message||String(x)})}};
function build({sourceFeatures=[],targetFeatures=[],options={}}){
 const sliver=Math.max(0,Number(options.sliverThreshold)||0.0001),allowCrossCounty=!!options.allowCrossCounty,edges=[],diagnostics=[];
 const S=sourceFeatures.map(info),T=targetFeatures.map(info),tById=new Map(T.map(x=>[x.id,x]));
 // Pass 1: exact GEOID continuity, retained even when geometry processing fails.
 for(const s of S){const t=tById.get(s.id);if(t)edges.push(edge(s,t,"exact-geoid"));}
 // Pass 2: all meaningful geometric intersections. Do not remove exact links.
 for(const s of S)for(const t of T){if(!s.id||!t.id||s.state!==t.state||(!allowCrossCounty&&s.county!==t.county)||!touch(s.box,t.box)||edges.some(e=>e.source===s.id&&e.target===t.id))continue;const e=edge(s,t,"polygon-intersection");if(e.intersectionArea>0&&Math.max(e.sourceShare,e.targetShare)>=sliver)edges.push(e)}
 // Pass 3: reciprocal/one-way point-on-surface containment rescue.
 const linkedS=new Set(edges.map(e=>e.source)),linkedT=new Set(edges.map(e=>e.target));
 for(const s of S.filter(x=>x.id&&!linkedS.has(x.id))){const candidates=T.filter(t=>compatible(s,t,allowCrossCounty)&&contains(t.feature,s.point));for(const t of candidates)edges.push(edge(s,t,"source-point-in-target"))}
 for(const t of T.filter(x=>x.id&&!linkedT.has(x.id))){const candidates=S.filter(s=>compatible(s,t,allowCrossCounty)&&contains(s.feature,t.point));for(const s of candidates)if(!edges.some(e=>e.source===s.id&&e.target===t.id))edges.push(edge(s,t,"target-point-in-source"))}
 // Pass 4: diagnostic nearest candidates only; never create graph edges from proximity.
 const finalS=new Set(edges.map(e=>e.source)),finalT=new Set(edges.map(e=>e.target));
 for(const s of S.filter(x=>x.id&&!finalS.has(x.id))){const d=nearest(s,T,"source",allowCrossCounty);diagnostics.push(d);if(d.nearestCandidate){const t=T.find(x=>x.id===d.nearestCandidate);if(t){const e=edge(s,t,"nearest-fallback");e.nearestDistanceKm=d.distanceKm;e.provisional=true;edges.push(e);}}}
 const afterS=new Set(edges.map(e=>e.source)),afterT=new Set(edges.map(e=>e.target));
 for(const t of T.filter(x=>x.id&&!afterT.has(x.id))){const d=nearest(t,S,"target",allowCrossCounty);diagnostics.push(d);if(d.nearestCandidate){const src=S.find(x=>x.id===d.nearestCandidate);if(src&&!edges.some(e=>e.source===src.id&&e.target===t.id)){const e=edge(src,t,"nearest-fallback");e.nearestDistanceKm=d.distanceKm;e.provisional=true;edges.push(e);}}}
 return {relationships:dedupe(edges),diagnostics,sourceBoundaryGeoids:S.map(x=>x.id).filter(Boolean),targetBoundaryGeoids:T.map(x=>x.id).filter(Boolean)};
}
function info(feature){const id=String(feature?.properties?.__pc_geoid||"");return{feature,id,state:id.slice(0,2),county:id.slice(2,5),area:area(feature),box:bbox(feature),point:point(feature)}}
function edge(s,t,evidence){const a=intersection(s.feature,t.feature),i=a.area,ss=s.area?i/s.area:0,ts=t.area?i/t.area:0,oc=Math.min(s.area,t.area)>0?i/Math.min(s.area,t.area):0,union=s.area+t.area-i,iou=union>0?i/union:0;return{source:s.id,target:t.id,evidenceType:evidence,intersectionArea:i,sourceShare:ss,targetShare:ts,overlapCoefficient:oc,iou,sameGeoid:s.id===t.id,sameState:s.state===t.state,sameCounty:s.county===t.county,sourcePointInTarget:contains(t.feature,s.point),targetPointInSource:contains(s.feature,t.point)}}
function compatible(a,b,cross){return a.state===b.state&&(cross||a.county===b.county)}
function dedupe(a){return[...new Map(a.map(x=>[`${x.source}|${x.target}`,x])).values()]}
function nearest(x,candidates,side,cross){let best=null;for(const y of candidates.filter(z=>compatible(x,z,cross))){const d=distance(x.point,y.feature);if(Number.isFinite(d)&&(!best||d<best.distanceKm))best={geoid:side==="source"?x.id:y.id,side,reason:"unresolved",nearestCandidate:side==="source"?y.id:x.id,distanceKm:d}}return best||{geoid:x.id,side,reason:"unresolved-no-compatible-candidate",nearestCandidate:null,distanceKm:null}}
function area(f){try{return turf.area(f)||0}catch(_){return 0}}function bbox(f){try{return turf.bbox(f)}catch(_){return null}}function point(f){try{return turf.pointOnFeature(f)}catch(_){return null}}function contains(f,p){try{return!!p&&turf.booleanPointInPolygon(p,f)}catch(_){return false}}function distance(p,f){try{return p?turf.pointToLineDistance(p,turf.polygonToLine(f),{units:"kilometers"}):Infinity}catch(_){return Infinity}}function touch(a,b){return a&&b&&a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1]}function intersection(a,b){try{const f=turf.intersect(a,b);return{area:f?area(f):0}}catch(_){return{area:0}}}
