/* Canonical Census GEOID normalization. */
window.PrettyCensusGeoid=(()=>{
 const digits=v=>String(v??"").replace(/\D/g,"");
 const part=(v,n)=>{const x=digits(v);return x?x.padStart(n,"0").slice(-n):""};
 function canonical(v,level){const n=level==="blockgroup"?12:11,x=digits(v);if(!x)return"";/* AFFGEOID/GEOIDFQ may contain summary-level prefixes such as 1500000US. The geographic GEOID is the final 11/12 digits. */return x.length>=n?x.slice(-n):x.padStart(n,"0")}
 function fromRow(r,l){const direct=canonical(r.GEOID??r.GEOIDFQ??r.geoid,l);if(direct)return direct;const base=part(r.state,2)+part(r.county,3)+part(r.tract,6);return l==="blockgroup"?base+part(r["block group"]??r.blockgroup,1):base}
 function fromFeature(f,l){const p=f?.properties||{};for(const k of ["GEOID","GEOIDFQ","GEOID20","GEOID10","geoid","AFFGEOID","AFFGEOID20","AFFGEOID10","__geoid"]){const x=canonical(p[k],l);if(x)return x}const base=part(p.STATEFP??p.STATEFP20??p.STATEFP10,2)+part(p.COUNTYFP??p.COUNTYFP20??p.COUNTYFP10,3)+part(p.TRACTCE??p.TRACTCE20??p.TRACTCE10,6);return l==="blockgroup"?base+part(p.BLKGRPCE??p.BLKGRPCE20??p.BLKGRPCE10,1):base}
 return{digits:part,canonical,fromRow,fromFeature};
})();
