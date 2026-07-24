<script setup lang="ts">
import { incrementCounter } from '../../examples/basic/src/actions'

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
