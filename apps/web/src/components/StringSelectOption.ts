import { computed, createVNode, defineComponent, ref } from "vue";
import { ElOption } from "element-plus/es/components/select/index";

// The vendor's option prop declarations do not support exactOptionalPropertyTypes.
// Adapt string-valued options at this boundary without weakening project checks.
export default defineComponent({
  // ElSelect identifies option VNodes by name when preserving keyboard order.
  name: "ElOption",
  props: {
    value: { type: String, required: true },
    label: { type: String, required: true },
    disabled: Boolean,
  },
  setup() {
    const option = ref<{ visible: boolean }>();
    // ElOptionGroup reads each named ElOption's public visibility when deciding
    // whether to hide the group. Forward the inner option's filtering state.
    const visible = computed(() => option.value?.visible ?? true);
    return { option, visible };
  },
  render() {
    return createVNode(ElOption, { ref: "option", value: this.value, label: this.label, disabled: this.disabled });
  },
});
