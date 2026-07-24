'use server'

import { getActionContext } from 'ministak/server'

let count = 0

export async function login() {
  const { reply } = getActionContext()
  reply.header(
    'set-cookie',
    'ministak_demo_session=logged-in; Path=/; HttpOnly; SameSite=Lax',
  )
}

export async function logout() {
  const { reply } = getActionContext()
  reply.header(
    'set-cookie',
    'ministak_demo_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
  )
}

export async function getCounter() {
  return count
}

export async function incrementCounter() {
  count += 1
  return count
}
