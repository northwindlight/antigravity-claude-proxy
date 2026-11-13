const assert = require('node:assert/strict');
(async () => {
  const { convertAnthropicToGoogle } = await import('../src/format/request-converter.js');
  const tools = [
    {name:'round', input_schema:{type:'object',properties:{},required:[],additionalProperties:false}},
    {name:'reject', input_schema:{type:'object',properties:{reason:{type:'string'}},required:['reason'],additionalProperties:false}},
    {name:'dynamic', input_schema:{type:'object',properties:{},additionalProperties:true}},
  ];
  const req = convertAnthropicToGoogle({model:'gemini-4-hydrogen-high',messages:[{role:'user',content:'test'}],tools,max_tokens:1024});
  const [round,reject,dynamic] = req.tools[0].functionDeclarations;
  assert.equal(Object.hasOwn(round, 'parameters'), false);
  assert.deepEqual(reject.parameters.required, ['reason']);
  assert.ok(reject.parameters.properties.reason);
  assert.ok(dynamic.parameters);
  console.log('parameterless tool conversion OK');
})().catch(e => { console.error(e); process.exit(1); });
