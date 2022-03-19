<script setup>
defineProps(["name", "date", "price", "isUp"]);
defineEmits(["click"]);
</script>

<template>
  <button class="flex flex-row w-full my-2 text-sm md:text-base" @click="$emit('click')">
    <div class="bg-gray-100 w-full flex flex-row px-4 py-2 rounded">
      <h1 class="font-semibold uppercase">{{ name }}</h1>
      <h2 class="ml-auto font-light text-gray-500">{{ date }}</h2>
    </div>
    <div
      class="flex flex-row w-24 justify-center px-4 py-2 ml-2 rounded"
      :class="{ 'bg-green-500': isUp, 'bg-red-500': !isUp }"
    >
      <span class="text-white">{{ isUp ? "▲" : "▼" }}</span>
      <h2 class="ml-2 text-white">£{{ price }}</h2>
    </div>
  </button>
</template>

<style scoped></style>
