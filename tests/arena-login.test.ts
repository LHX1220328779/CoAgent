import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserNetwork,browserHeadless} from '../src/arena/network.ts';

test('Arena browser uses the configured shell proxy and honors an explicit override',()=>{
  const inherited=browserNetwork({https_proxy:'http://127.0.0.1:7897',http_proxy:'http://127.0.0.1:7898'});
  assert.equal(inherited.source,'https_proxy');assert.equal(inherited.proxy!.server,'http://127.0.0.1:7897');
  assert.equal(browserNetwork({ARENA_AGENT_PROXY:'socks5://127.0.0.1:1080',HTTPS_PROXY:'http://127.0.0.1:7897'}).proxy!.server,'socks5://127.0.0.1:1080');
  assert.equal(browserNetwork({ARENA_AGENT_PROXY:'none',https_proxy:'http://127.0.0.1:7897'}).proxy,undefined);
  assert.equal(browserHeadless({DISPLAY:':0'}),false);assert.equal(browserHeadless({WAYLAND_DISPLAY:'wayland-0'}),false);
  assert.equal(browserHeadless({}),true);assert.equal(browserHeadless({DISPLAY:':0',ARENA_HEADED:'0'}),true);
});

test('proxy authentication uses browser fields and invalid settings do not fall back to direct',()=>{
  const {proxy}=browserNetwork({HTTPS_PROXY:'http://test%40user:fixture%3Apassword@127.0.0.1:7897'});
  assert.deepEqual(proxy,{server:'http://127.0.0.1:7897',username:'test@user',password:'fixture:password'});
  assert.throws(()=>browserNetwork({ARENA_AGENT_PROXY:'invalid',https_proxy:'http://127.0.0.1:7897'}));
  assert.throws(()=>browserNetwork({ARENA_AGENT_PROXY:'file:///tmp/proxy'}));
});
