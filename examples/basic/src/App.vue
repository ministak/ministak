<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ServerActionError } from 'ministak/client'
import { getCounter, incrementCounter, login, logout } from './actions'

const count = ref<number | null>(null)
const message = ref('')
const loading = ref(false)

onMounted(async () => {
  count.value = await getCounter()
})

async function handleLogin() {
  await login()
  message.value = '已登录'
}

async function handleLogout() {
  await logout()
  message.value = '已登出'
}

async function increment() {
  try {
    count.value = await incrementCounter().bindLoading(loading)
    message.value = ''
  } catch (error) {
    if (!(error instanceof ServerActionError)) {
      throw error
    }
    message.value = error.message
  }
}
</script>

<template>
  <main>
    <h1>计数器</h1>
    <p class="output">{{ count }}</p>
    <div class="actions">
      <button @click="handleLogin">登录</button>
      <button @click="handleLogout">登出</button>
      <button @click="increment">+1</button>
    </div>
    <p class="output">
      请求状态：{{ loading ? '进行中' : '空闲' }}
    </p>
    <p class="output">{{ message }}</p>
  </main>
</template>

<style scoped>
:global(body) {
  margin: 0;
}

main {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.actions {
  display: flex;
  gap: 8px;
}

.output {
  height: 24px;
}

button {
  height: 32px;
}
</style>
