<script setup lang="ts">
type Props = {
	middleWidth?: string;
};
withDefaults(defineProps<Props>(), { middleWidth: '160px' });
</script>

<template>
	<div :class="$style.container">
		<div :class="$style.items">
			<div v-if="$slots.left" :class="[$style.item, $style.itemFirst]">
				<slot name="left"></slot>
			</div>
			<div
				v-if="$slots.middle"
				:class="[$style.item, $style.itemMiddle]"
				:style="{ '--input-triple--width': middleWidth }"
			>
				<slot name="middle"></slot>
			</div>
			<div v-if="$slots.right" :class="[$style.item, $style.itemLast]">
				<slot name="right"></slot>
			</div>
		</div>
	</div>
</template>

<style lang="scss" module>
.container {
	--parameter-input-options--height: 22px;
	container: input-triple / inline-size;
	width: 100%;
}

.items {
	display: flex;
	flex-wrap: wrap;
}

.item {
	position: relative;
	flex: 1;
	min-width: 0;

	input {
		box-sizing: content-box;
	}

	:global(.n8n-input) {
		gap: 0;
	}

	&:focus-within {
		z-index: 1;
	}
}

.itemMiddle {
	margin: 0 -1px;
	flex-basis: var(--input-triple--width, 160px);
	flex-grow: 0;
}

.itemFirst {
	input {
		border-top-right-radius: 0;
		border-bottom-right-radius: 0;
	}
}

.itemLast {
	input {
		border-top-left-radius: 0;
		border-bottom-left-radius: 0;
	}
}

// Stacked layout when container is narrow
@container input-triple (max-width: 400px) {
	.item {
		flex-basis: 100%;
		margin: 0;
		margin-top: -1px;

		&:first-child {
			margin-top: 0;
		}
	}

	.itemMiddle {
		flex-basis: 100%;
	}

	.itemFirst input {
		border-radius: var(--radius) var(--radius) 0 0;
	}

	.itemMiddle input {
		border-radius: 0;
	}

	.itemLast input {
		border-radius: 0 0 var(--radius) var(--radius);
	}
}
</style>
