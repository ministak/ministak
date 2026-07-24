<script setup lang="ts">
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
  const result = await incrementCounter()
  result.toFixed()

  // @ts-expect-error incrementCounter 不接受参数
  await incrementCounter(1)

  // @ts-expect-error number 不存在 unknownField
  result.unknownField
}

void verifyServerActionTypes
</script>

<template>
  <div />
</template>
