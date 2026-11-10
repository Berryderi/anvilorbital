// Fleet Retirement Planner model, shared by planner/ and simulator/ (moved unchanged from planner/index.html).
// Classic script: its top-level consts are globals the pages read.
// MODEL-START
// Mirrors tools/planner/planner.py, tools/decay/decay.py and tools/orbits/orbits.py
const MU=3.986004418e14,RE=6378137,SEC=3.15576e7,CD=2.2,REENTRY=180,LIMIT=5,RELEASE=300,ALUMINA=30/250,G0=9.80665;
const T=[[150,2.070e-9,22.523],[180,5.464e-10,29.740],[200,2.789e-10,37.105],[250,7.248e-11,45.546],[300,2.418e-11,53.628],[350,9.518e-12,53.298],[400,3.725e-12,58.515],[450,1.585e-12,60.828],[500,6.967e-13,63.822],[600,1.454e-13,71.835],[700,3.614e-14,88.667],[800,1.170e-14,124.64],[900,5.245e-15,181.05],[1000,3.019e-15,268.00]];
function density(h){let r=T[0];for(const x of T){if(x[0]<=h)r=x;}return r[1]*Math.exp(-(h-r[0])/r[2]);}
function lifetimeYears(alt,mA,f){let y=0,h=alt;while(h>REENTRY){const a=RE+h*1000;const rate=density(h)*f*Math.sqrt(MU*a)*CD/mA;y+=(1000/rate)/SEC;h-=1;}return y;}
function circSpeed(h){return Math.sqrt(3.9860e14/(RE+h*1000));}
function edelbaum(a,b){const v1=circSpeed(a),v2=circSpeed(b);return Math.sqrt(v1*v1+v2*v2-2*v1*v2*Math.cos(0));}
function propellantFor(m,dv,isp){return m*(Math.exp(dv/(G0*isp))-1);}
function status(mean,high,low){if(low<=LIMIT)return "clears";if(high>LIMIT)return "misses";return "depends";}
function evaluate(count,mass,area,alt,life,fail,launch,prop,isp,service,value){
  const mA=mass/area,mean=lifetimeYears(alt,mA,1),high=lifetimeYears(alt,mA,3),low=lifetimeYears(alt,mA,0.3);
  const dv=alt>RELEASE?edelbaum(alt,RELEASE):0,propellant=propellantFor(mass,dv,isp),fuel=propellant*(prop+launch);
  const alt_cost=low<=LIMIT?0:fuel,retired=count/life,failed=retired*fail,be=alt_cost+value;
  return {mean,high,low,status:status(mean,high,low),propellant_kg:propellant,fuel_usd:fuel,alternative_usd:alt_cost,retired_per_year:retired,failed_per_year:failed,fleet_fuel_usd_per_year:retired*alt_cost,alumina_t_per_year:retired*mass*ALUMINA/1000,breakeven_usd:be,service_wins:service<=be};
}
// MODEL-END
