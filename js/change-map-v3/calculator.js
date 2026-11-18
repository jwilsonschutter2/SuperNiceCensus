ChangeMapV3.Calculator=(()=>{
 const n=v=>{const x=Number(v);return Number.isFinite(x)?x:null};
 const sum=a=>a.reduce((x,y)=>x+(n(y)||0),0);
 function run(groups,variable,strategy){
  for(const g of groups){
   const sv=g.sources.map(x=>n(x.row[variable])),tv=g.targets.map(x=>n(x.row[variable]));
   const valid=sv.every(Number.isFinite)&&tv.every(Number.isFinite);
   const direct=['direct_geoid','renumbered_direct'].includes(g.type);
   g.sourceTotal=strategy==='additive'&&valid?sum(sv):(direct&&valid?sv[0]:null);
   g.targetTotal=strategy==='additive'&&valid?sum(tv):(direct&&valid?tv[0]:null);
   g.analyticalStatus=g.sourceTotal===null||g.targetTotal===null?'not_comparable_changed_geography':'comparable';
   g.numericChange=g.analyticalStatus==='comparable'?g.targetTotal-g.sourceTotal:null;
   g.percentChange=g.numericChange!==null&&g.sourceTotal!==0?g.numericChange/g.sourceTotal*100:null;
   g.pctStatus=g.sourceTotal===0?'zero_baseline':g.analyticalStatus;
  }
  return groups;
 }
 return{run};
})();
