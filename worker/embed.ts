export function embedScript(origin: string): string {
  return `(function(){var s=document.currentScript;if(!s)return;var slug=s.getAttribute("data-slug");if(!slug)return;var o=${JSON.stringify(origin)};
function hex(){var a=new Uint8Array(8);crypto.getRandomValues(a);return Array.from(a,function(b){return b.toString(16).padStart(2,"0")}).join("")}
var vid;try{vid=localStorage.getItem("cairn_vid");if(!vid||vid.length<16){vid=hex()+hex();localStorage.setItem("cairn_vid",vid)}}catch(e){vid=hex()+hex()}
var land;try{land=localStorage.getItem("cairn_land");if(!land){land=location.pathname||"/";localStorage.setItem("cairn_land",land)}}catch(e){land=location.pathname||"/"}
var q=new URLSearchParams(location.search);
function ping(t,extra){try{fetch(o+"/t/"+encodeURIComponent(slug)+"/collect",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(Object.assign({t:t,p:location.pathname,r:document.referrer||"",h:location.hostname,us:q.get("utm_source")||"",um:q.get("utm_medium")||"",uc:q.get("utm_campaign")||"",vid:vid,land:land},extra||{})),mode:"cors",keepalive:true,credentials:"omit"})}catch(e){}}
function withVid(url){try{var u=new URL(url,location.href);u.searchParams.set("cairn_vid",vid);return u.toString()}catch(e){return url}}
function rewriteCheckout(a){if(!a||!a.hasAttribute||!a.hasAttribute("data-cairn-checkout"))return;var href=a.getAttribute("href");if(!href)return;try{a.setAttribute("href",withVid(href))}catch(e){}}
ping("pageview");
window.cairnSignup=window.whypaidSignup=window.launchmapSignup=function(){ping("signup")};
window.cairnEvent=function(n){ping("event",{n:String(n||"event").slice(0,80)})};
window.cairnPay=function(cents){ping("payment",{amount_cents:Math.max(0,Math.round(Number(cents)||0))})};
window.cairnCheckoutUrl=function(url){return withVid(url)};
document.addEventListener("click",function(ev){var el=ev.target;if(!el||!el.closest)return;var named=el.closest("[data-cairn-event]");if(named){ping("event",{n:named.getAttribute("data-cairn-event")||"click"})}var a=el.closest("a[href]");if(a){rewriteCheckout(a);var href=a.getAttribute("href")||"";var path=href;try{path=new URL(href,location.href).pathname||href}catch(e){}if(!named){ping("event",{n:"click",p:String(path).slice(0,180)})}}},true);
function scan(){document.querySelectorAll("a[data-cairn-checkout]").forEach(rewriteCheckout)}
scan();if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",scan);})();`;
}
