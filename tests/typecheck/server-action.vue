<script setup lang="ts">
import { ref } from 'vue'
import { setServerActionHooks } from 'ministak/client'
import { incrementCounter } from '../../examples/basic/src/actions'

setServerActionHooks({
  onRequest({ action }) {
    if (action === incrementCounter) {
      return
    }
  },
})

async function verifyServerActionTypes() {
  const request = incrementCounter()
  const loading = ref(false)
  const boundRequest = request.bindLoading(loading)
  request.loading.valueOf()
  boundRequest.loading.valueOf()
  const result = await request
  result.toFixed()

  // @ts-expect-error incrementCounter 不接受参数
  await incrementCounter(1)

  // @ts-expect-error number 不存在 unknownField
  result.unknownField

  // @ts-expect-error 普通 Promise 没有 loading
  Promise.resolve().loading

  // @ts-expect-error bindLoading 只接受布尔 Ref
  request.bindLoading(ref(''))
}

void verifyServerActionTypes
</script>

<template>
  <div />
</template>
