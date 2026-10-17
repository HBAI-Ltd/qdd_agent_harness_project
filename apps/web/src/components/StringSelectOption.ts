import { createVNode, defineComponent } from "vue";
import { ElOption } from "element-plus";

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
  setup(props) {
    return () => createVNode(ElOption, { value: props.value, label: props.label, disabled: props.disabled });
  },
});
