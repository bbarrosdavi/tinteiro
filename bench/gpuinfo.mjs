const v = await (await fetch('http://127.0.0.1:9333/json/version')).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
ws.send(JSON.stringify({ id: 1, method: 'SystemInfo.getInfo' }));
const msg = await new Promise(r => ws.addEventListener('message', e => r(JSON.parse(e.data))));
console.log(JSON.stringify({ status: msg.result.gpu.featureStatus, dev: msg.result.gpu.devices.map(d => d.deviceString) }, null, 1));
ws.close();
