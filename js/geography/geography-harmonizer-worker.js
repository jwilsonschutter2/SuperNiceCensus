/* Relationship-group candidate-link worker. Geometry creates graph edges;
 * overlap measures are QA evidence only and never Census-value weights. */
importScripts("https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js");
self.onmessage=e=>{try{self.postMessage(build(e.data))}catch(x){self.postMessage({error:x.message||String(x)})}};
function build({sourceFeatures=[],targetFeatures=[],options={}}){
 const sliver=Math.max(0,Number(options.sliverThreshold)||0.001), allowCrossCounty=!!options.allowCrossCounty, edges=[],diagnostics=[];
 const targets=targetFeatures.map(f=>info(f)).filter(x=>x.id&&x.area&&x.box);
 for(const sf of sourceFeatures){const s=info(sf);if(!s.id||!s.area||!s.box){diagnostics.push({geoid:s.id,side:"source",reason:"invalid geometry"});continue}let found=0;
  for(const t of targets){if(s.state!==t.state||(!allowCrossCounty&&s.county!==t.county)||!touch(s.box,t.box))continue;const x=intersection(sf,t.feature);if(!x.area)continue;const sourceShare=x.area/s.area,targetShare=x.area/t.area,overlapCoefficient=x.area/Math.min(s.area,t.area);if(Math.max(sourceShare,targetShare)<sliver)continue;edges.push({source:s.id,target:t.id,intersectionArea:x.area,sourceShare,targetShare,overlapCoefficient,sameGeoid:s.id===t.id,sameState:s.state===t.state,sameCounty:s.county===t.county,method:"polygon-intersection"});found++}if(!found)diagnostics.push({geoid:s.id,side:"source",reason:"unmatched"});}
 return {relationships:edges,diagnostics};
}
function info(feature){const id=String(feature?.properties?.__pc_geoid||"");return {feature,id,state:id.slice(0,2),county:id.slice(2,5),area:area(feature),box:bbox(feature)}}
function area(f){try{const n=turf.area(f);return Number.isFinite(n)&&n>0?n:0}catch(_){return 0}}
function bbox(f){try{return turf.bbox(f)}catch(_){return null}}
function touch(a,b){return a&&b&&a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1]}
function intersection(a,b){try{const f=turf.intersect(a,b);return {area:f?area(f):0}}catch(_){return {area:0}}}
