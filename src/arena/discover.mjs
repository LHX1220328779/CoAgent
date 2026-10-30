// Read existing, authorized Agent history. No model turn or new session is created.
export async function discoverSessions(browser,credential){
  return browser.withAccount(credential,async()=>{
    const page=await browser.getPage(credential,'coagent-catalog');
    const response=await page.goto('https://arena.ai/agent',{waitUntil:'domcontentloaded',timeout:45000});
    if([401,403,429].includes(response?.status()))throw Object.assign(new Error('Arena 要求重新登录、验证或稍后再试'),{status:response.status()});
    if(!await browser.sessionIsUsable(page,credential.email))throw Object.assign(new Error('该账号的网页登录状态不可用'),{status:401});
    await page.locator('a[href*="/agent/"]').first().waitFor({state:'attached',timeout:8000}).catch(()=>{});
    const sessions=new Map();let stable=0;
    for(let pass=0;pass<40;pass++){
      const found=await page.locator('a[href*="/agent/"]').evaluateAll(links=>{
      const entries=[];
      for(const link of links){const url=new URL(link.getAttribute('href'),location.origin),id=url.pathname.match(/^\/agent\/([0-9a-f-]{36})\/?$/i)?.[1];if(url.origin!==location.origin||!id)continue;
        const title=link.getAttribute('title')??link.getAttribute('aria-label')??link.textContent??'';
        entries.push({id:id.toLowerCase(),title,url:url.href});
      }return entries;
      });
      const count=sessions.size;for(const entry of found)sessions.set(entry.id,entry);
      stable=sessions.size===count?stable+1:0;if(stable>=2)break;
      // Read lazy-loaded history through its normal scroll container, without opening turns.
      await page.locator('a[href*="/agent/"]').evaluateAll(links=>{
        const containers=new Set();for(const link of links)for(let node=link.parentElement;node;node=node.parentElement)if(node.scrollHeight>node.clientHeight&&/(auto|scroll)/.test(getComputedStyle(node).overflowY)){containers.add(node);break;}
        if(document.scrollingElement)containers.add(document.scrollingElement);
        for(const node of containers)node.scrollTop+=Math.max(100,node.clientHeight*.8);
      });
      await page.waitForTimeout(250);
    }
    return [...sessions.values()];
  });
}
