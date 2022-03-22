<script setup>
defineProps(["email", "price"]);
defineEmits(["click"]);
</script>

<template>
  <button @click="$emit('click')" class="flex flex-row w-full my-2">
    <div
      class="flex flex-row w-24 justify-center px-4 py-2 mr-2 rounded bg-amber-500 text-sm sm:text-base"
    >
      <h2 class="text-white">£ {{ price }}</h2>
    </div>
    <div class="bg-gray-100 w-full flex flex-row px-4 py-2 rounded text-sm sm:text-base">
      <h1 class="font-semibold">{{ email }}</h1>
    </div>
  </button>
</template>

<style scoped></style>
