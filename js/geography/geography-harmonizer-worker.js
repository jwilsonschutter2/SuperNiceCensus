/* Geography-Normalized Census Change Analysis relationship worker.
 * Geometry establishes graph membership. GEOIDs verify stable 1-to-1 matches.
 * Overlap percentages are QA evidence only and are never allocation weights.
 */
importScripts("https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js");
self.onmessage = (event) => { try { self.postMessage(build(event.data)); } catch (e) { self.postMessage({error:e.message||String(e)}); } };
function build({sourceFeatures,targetFeatures,level,options={}}){
 const minIntersection=Number(options.minIntersectionArea)||0, stableThreshold=Number(options.stableThreshold)||0.99;
 const relationships=[], diagnostics=[]; let intersectionErrors=0;
 const targets=targetFeatures.map((f,i)=>({f,i,id:String(f.properties?.__pc_geoid||""),box:safeBbox(f),area:safeArea(f)}));
 for(const source of sourceFeatures){
  const sourceId=String(source.properties?.__pc_geoid||""), sourceArea=safeArea(source), box=safeBbox(source);
  if(!sourceId||!sourceArea||!box){diagnostics.push({source:sourceId,reason:"invalid-source"});continue;}
  let found=0;
  for(const t of targets){
   if(!t.id||!t.area||!bboxTouches(box,t.box)) continue;
   const x=safeIntersection(source,t.f); if(x.error){intersectionErrors++;continue;} if(x.area<=minIntersection) continue;
   const sourceShare=x.area/sourceArea, targetShare=x.area/t.area;
   // Prevent sliver-only graph links; this does not weight values.
   if(Math.max(sourceShare,targetShare)<0.001) continue;
   const sameCounty=sourceId.slice(0,5)===t.id.slice(0,5), sameGeoid=sourceId===t.id;
   relationships.push({source:sourceId,target:t.id,intersectionArea:x.area,sourceShare,targetShare,sameGeoid,sameCounty,stableVerified:sameGeoid&&sourceShare>=stableThreshold&&targetShare>=stableThreshold,method:"polygon-intersection",forced:false}); found++;
  }
  if(!found) diagnostics.push({source:sourceId,reason:"no-geographic-relationship"});
 }
 return {relationships,diagnostics,intersectionErrors,forcedNearest:0};
}
function safeArea(f){try{const a=turf.area(f);return Number.isFinite(a)&&a>0?a:0}catch(_){return 0}}
function safeBbox(f){try{return turf.bbox(f)}catch(_){return null}}
function bboxTouches(a,b){return a&&b&&a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1]}
function safeIntersection(a,b){try{const x=turf.intersect(a,b);return {area:x?safeArea(x):0,error:false}}catch(_){return {area:0,error:true}}}
