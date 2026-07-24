import Fastify from 'fastify'
import { ActionError } from 'ministak/server'

const app = Fastify()

app.addHook('onRequest', async (request) => {
  if (
    request.serverAction?.name === 'src/actions.ts#incrementCounter' &&
    !request.headers.cookie
      ?.split(';')
      .some(
        (cookie) =>
          cookie.trim() === 'ministak_demo_session=logged-in',
      )
  ) {
    throw new ActionError('请先登录', {
      code: 'UNAUTHORIZED',
      status: 401,
    })
  }
})

export default app
