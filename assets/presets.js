// Planner presets, shared by planner/ and simulator/ (moved unchanged from planner/index.html).
const EXAMPLES={
 "Big-array data center fleet (example)":{count:1000,mass:3000,area:333.3,alt:700,life:5,fail:1,launch:500,prop:3000,isp:1500,service:8320000,value:0},
 "Same fleet, flying lower (example)":{count:1000,mass:3000,area:333.3,alt:600,life:5,fail:1,launch:500,prop:3000,isp:1500,service:8320000,value:0},
 "Much better servicer, if parts found a buyer (example)":{count:1000,mass:3000,area:333.3,alt:750,life:5,fail:1,launch:500,prop:3000,isp:1500,service:800000,value:770000},
 "Reuse a retiring satellite's power for compute, best-case servicer (example)":{count:1000,mass:3000,area:333.3,alt:700,life:5,fail:1,launch:500,prop:3000,isp:1500,service:800000,value:969000},
 "Small imaging constellation (example)":{count:100,mass:150,area:1.5,alt:550,life:5,fail:3,launch:3245,prop:3000,isp:1500,service:2000000,value:0},
 "Mid-size broadband fleet, high orbit (example)":{count:300,mass:150,area:1.5,alt:1200,life:7,fail:2,launch:3245,prop:3000,isp:1500,service:2000000,value:0}};
// Real fleets: every input carries its source (checked 2026-11-10). Unlinked = our assumption.
const MCD="Jonathan McDowell, planet4589.org",FAIL=["Fail before disposal: our assumption (planner default)"],
 COSTS_BB=["Costs: our assumptions, same as the broadband example"],COSTS_DC=["Costs: our assumptions, same as the data center example"],
 BB={fail:1,launch:3245,prop:3000,isp:1500,service:2000000,value:0},DC={fail:1,launch:500,prop:3000,isp:1500,service:8320000,value:0};
const REAL={
 "Starlink V2 Mini (SpaceX)":{...BB,count:8061,mass:575,area:43.1,alt:470,life:5,src:[
  ["Satellites: 8,061 Gen2 in orbit on 2026-11-09, mixing original, Optimized and direct-to-cell V2 Minis, all modelled at 575 kg, "+MCD,"https://planet4589.org/space/con/star/stats.html"],
  ["Mass: 575 kg, V2 Mini Optimized; the original V2 Minis are heavier, so mass is low for part of the fleet (SpaceX)","https://starlink.com/public-files/starlinkProgressReport_2024.pdf"],
  ["Drag area: 43.1 m², our estimate per satellite: the area-to-mass SpaceX reported for one Gen2 satellite (STARLINK-32445, 0.075 m²/kg) times 575 kg (SpaceX FCC report, July 2026)","https://api-prod.fcc.gov/icfs-attachment/exp/api/v1/bff0244acfb947505791bf252f851ce6"],
  ["Altitude: 470 km, middle of SpaceX's stated 450 to 490 km; service life: 5 years, SpaceX says designed for 5+ (SpaceX)","https://space-safety.starlink.com/docs/space-safety-articles/constellation_altitudes/"],
  FAIL,COSTS_BB]},
 "Eutelsat OneWeb Gen 1":{...BB,count:654,mass:150,area:1.8,alt:1200,life:5,src:[
  ["Satellites: 654 in orbit on 2026-11-09, "+MCD,"https://planet4589.org/space/con/ow/stats.html"],
  ["Mass: about 150 kg; service life: at least 5 years at 1,200 km (eoPortal)","https://directory.eoportal.org/satellite-missions/oneweb"],
  ["Drag area: 1.8 m², our estimate from the 1 x 1 x 1.3 m body (eoPortal). Array size isn't published, so it's left out and the estimate is low","https://directory.eoportal.org/satellite-missions/oneweb"],
  ["Altitude: 1,200 km (Eutelsat)","https://www.eutelsat.com/satellite-network/oneweb-leo-constellation"],
  FAIL,COSTS_BB]},
 "Amazon Leo (formerly Kuiper)":{...BB,count:392,mass:554,area:41.6,alt:630,life:7,src:[
  ["Satellites: 392 in orbit on 2026-11-09, "+MCD,"https://planet4589.org/space/con/kp/stats.html"],
  ["Mass: 554 kg, middle of a 537 to 571 kg press estimate; Amazon hasn't published it (Gigazine, reporting Ars Technica)","https://gigazine.net/gsc_news/en/20250514-amazon-kuiper-satellite"],
  ["Drag area: 41.6 m², our assumption: the area-to-mass SpaceX reported for one Starlink satellite (0.075 m²/kg) times 554 kg. Amazon hasn't published the size"],
  ["Altitude: 630 km, the assigned operational altitude (Amazon)","https://www.aboutamazon.com/news/innovation-at-amazon/project-kuiper-satellite-rocket-launch-progress-updates"],
  ["Service life: 7 years, the mission length in the FCC's disposal condition (ExecutiveGov)","https://www.executivegov.com/articles/fcc-oks-amazons-updated-orbital-debris-mitigation-plan-for-broadband-satellite"],
  FAIL,COSTS_BB]},
 "Starcloud orbital data center (count and altitude from its FCC filing)":{...DC,count:88000,mass:3000,area:320,alt:725,life:5,src:[
  ["Satellites: up to 88,000 filed with the FCC, not approved; altitude: 725 km, middle of the filed 600 to 850 km (Starcloud filing)","https://api-prod.fcc.gov/icfs-attachment/exp/api/v1/5c6840321b3e365068b6a64ce54bcb49"],
  ["Disposal: the filing gives heights and plans \"controlled atmospheric re-entry\", each satellite \"designed for full demisability\", but gives no mass or size. The disposal-cost card prices a different plan, lowering by thruster to 300 km, which is our assumption (Starcloud filing)","https://api-prod.fcc.gov/icfs-attachment/exp/api/v1/5c6840321b3e365068b6a64ce54bcb49"],
  ["Mass: 3,000 kg, the planned 200 kW Starcloud-3 (The Next Web)","https://thenextweb.com/news/starcloud-170m-series"],
  ["Drag area: 320 m², our estimate: 200 kW at 3.2 m² of array per kW (Starcloud white paper: 4 x 4 km for 5 GW), counted at half. Radiators left out, so the estimate is low","https://starcloudinc.github.io/wp.pdf"],
  ["Service life: 5 years, our assumption (not published)"],
  FAIL,COSTS_DC]},
 "SpaceX orbital data center filing (Starmind)":{...DC,count:100000,mass:4000,area:400,alt:475,life:5,src:[
  ["Satellites: 100,000 filed with the FCC, the first phase of up to 1,000,000, not approved; altitude: 475 km, the upper of two filed bands; power: 250 kW each, as reported (Advanced Television)","https://www.advanced-television.com/?p=292409"],
  ["Mass: up to 4,000 kg each (SatNews, on SpaceX's FCC submission)","https://satnews.com/2026/09/19/spacex-submits-fcc-re-entry-debris-and-collision-risk-analysis-for-starmind-orbital-data-center-constellation/"],
  ["Drag area: 400 m², our assumption: a reported 250 kW at Starcloud's white-paper 3.2 m² per kW, counted at half. Radiators left out, so the estimate is low","https://starcloudinc.github.io/wp.pdf"],
  ["Size: a 75 m wingspan is reported, but not the array width, so it can't give an area and isn't used (Advanced Television)","https://www.advanced-television.com/?p=292409"],
  ["Service life: 5 years, our assumption (not published)"],
  FAIL,COSTS_DC]}};
const EX_SRC=[["Illustration: every input is our assumption, not a real fleet"]];
const PRESETS={...REAL,...EXAMPLES};
// Link ids: /planner/#<id> opens that preset, so a message can link straight to one fleet.
const LINK_IDS={"Starlink V2 Mini (SpaceX)":"starlink","Eutelsat OneWeb Gen 1":"oneweb","Amazon Leo (formerly Kuiper)":"amazon-leo",
 "Starcloud orbital data center (count and altitude from its FCC filing)":"starcloud","SpaceX orbital data center filing (Starmind)":"starmind",
 "Big-array data center fleet (example)":"data-center","Same fleet, flying lower (example)":"data-center-lower",
 "Much better servicer, if parts found a buyer (example)":"better-servicer","Reuse a retiring satellite's power for compute, best-case servicer (example)":"reuse-power",
 "Small imaging constellation (example)":"imaging","Mid-size broadband fleet, high orbit (example)":"broadband-high"};
// No prototype, so a hash like #constructor or #__proto__ can't match an inherited property.
const BY_LINK_ID=Object.assign(Object.create(null),Object.fromEntries(Object.entries(LINK_IDS).map(([n,id])=>[id,n])));
