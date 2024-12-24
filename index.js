const Koa = require('koa')
const Router = require('koa-router')
const bodyParser = require('koa-bodyparser')
const models = require("./models")


const app = new Koa()
const router = new Router()

// 使用 bodyParser 中间件
app.use(bodyParser())

// 配置 bodyParser
app.use(bodyParser({
  enableTypes: ['json', 'form', 'text'],
  jsonLimit: '30mb',  // JSON 数据大小限制
  formLimit: '30mb',  // form 数据大小限制
  textLimit: '30mb',  // text 数据大小限制
}))


const makeRequest = async (session_id, requestModel, messages) => {
  // console.log(session_id, requestModel, messages)
  try {
    // 设置请求头
    const myHeaders = new Headers()
    myHeaders.append("Cookie", `session_id=${session_id}`)
    myHeaders.append("User-Agent", "Apifox/1.0.0 (https://apifox.com)");
    myHeaders.append("Content-Type", "application/json")
    myHeaders.append("Accept", "*/*")
    myHeaders.append("Host", "www.genspark.ai")
    myHeaders.append("Connection", "keep-alive")


    // 设置请求体
    var body = JSON.stringify({
      "type": "COPILOT_MOA_CHAT",
      "current_query_string": "type=COPILOT_MOA_CHAT",
      "messages": messages,
      "action_params": {},
      "extra_data": {
        "models": [
          models[`${requestModel}`] || models["claude-3-5-sonnet-20241022"]
        ],
        "run_with_another_model": false,
        "writingContent": null
      }
    })

    const requestConfig = {
      method: 'POST',
      headers: myHeaders,
      body: body,
      redirect: 'follow'
    };

    // console.log(requestConfig)
    return await fetch("https://www.genspark.ai/api/copilot/ask", requestConfig)
  } catch (error) {
    console.log('error1', error)
  }
}


router.post('/v1/chat/completions', async (ctx) => {
  const { messages, stream = false, model = 'claude-3-5-sonnet' } = ctx.request.body
  const session_id = ctx.get('Authorization')?.replace('Bearer ', '')

  if (!session_id) {
    ctx.status = 401
    ctx.body = { error: '未提供有效的 session_id' }
    return
  }

  try {
    const response = await makeRequest(session_id, model, messages)
    if (stream == "true" || stream == true) {
      ctx.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
    } else {
      ctx.set({
        'Content-Type': 'application/json',
      })
    }

    const messageId = crypto.randomUUID()
    const reader = response.body.getReader()
    if (stream == "true" || stream == true) {
      ctx.res.write(`data: ${JSON.stringify({
        "id": `chatcmpl-${messageId}`,
        "choices": [
          {
            "index": 0,
            "delta": {
              "content": "",
              "role": "assistant"
            }
          }
        ],
        "created": Math.floor(Date.now() / 1000),
        "model": models[`${model}`],
        "object": "chat.completion.chunk"
      })}\n\n`)
    }

    try {
      let resBody = {}

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          if (stream == "true" || stream == true) {
            // 发送完成标记
            ctx.res.write('data: [DONE]\n\n')
          }
          break
        }

        if (stream) {

          const text = new TextDecoder().decode(value)
          const textContent = [...text.matchAll(/data:.*"}/g)]

          textContent.forEach(item => {
            if (!item[0]) {
              return
            }

            const content = JSON.parse(item[0].replace("data: ", ''))
            if (!content || !content.delta) {
              return
            }

            // console.log(content.delta)

            // 发送增量内容
            ctx.res.write(`data: ${JSON.stringify({
              "id": `chatcmpl-${messageId}`,
              "choices": [
                {
                  "index": 0,
                  "delta": {
                    "content": content.delta
                  }
                }
              ],
              "created": Math.floor(Date.now() / 1000),
              "model": models[`${model}`],
              "object": "chat.completion.chunk"
            })}\n\n`)
          })
        } else {
          const text = new TextDecoder().decode(value)
          const textContent = [...text.matchAll(/data:.*"}/g)]


          textContent.forEach(item => {
            if (!item[0]) {
              return
            }

            const content = JSON.parse(item[0].replace("data: ", ''))
            if (!content || !content.field_value || content.field_name == 'session_state.answer_is_finished' || content.field_name == 'content' || content.field_name == 'session_state' || content.delta || content.type == 'project_field') {
              return
            }

            // console.log(content)

            resBody = {
              id: `chatcmpl-${messageId}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: content.field_value,
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: content.field_value.length,
              },
            }

          })
        }

      }

      if (stream == "false" || stream == false) {
        // console.log(resBody)
        ctx.body = resBody
      } else {
        ctx.res.end()
      }
      return
    } catch (error) {
      console.error('流式响应出错:', error)
      ctx.res.end()
    }

  } catch (error) {
    console.error('请求处理出错:', error)
    ctx.status = 500
    ctx.body = { error: '请求处理失败' }
  }
})


// 获取models
router.get('/v1/models', async (ctx) => {
  ctx.body = {
    object: "list",
    data: Object.keys(models).map(model => ({
      id: model,
      object: "model",
      created: 1706745938,
      owned_by: "genspark"
    }))
  }
})

router.get('/', (ctx) => {
  ctx.body = {
    message: "app running",
    status: "success"
  }
})

// 注册路由
app.use(router.routes()).use(router.allowedMethods())

// 错误处理中间件
app.use(async (ctx, next) => {
  try {
    await next()
  } catch (err) {
    ctx.status = err.status || 500
    ctx.body = {
      success: false,
      message: err.message
    }
    ctx.app.emit('error', err, ctx)
  }
})

// 启动服务器
const PORT = process.env.PORT || 8666
app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
})
