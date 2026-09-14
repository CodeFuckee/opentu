import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

export default function FormPage() {
  return (
    <div className="h-full">
      <FieldSet>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="feedback" className="sr-only">
              反馈
            </FieldLabel>
            <Textarea
              id="feedback"
              placeholder="你的反馈能帮助我们改进…"
              rows={4}
            />
            <FieldDescription>
              分享你对我们服务的想法。
            </FieldDescription>
          </Field>
        </FieldGroup>
      </FieldSet>
    </div>
  );
}
