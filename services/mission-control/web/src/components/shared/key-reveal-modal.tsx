import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

/**
 * Shown exactly once when a fresh bearer token (agent / connector / PAT) is
 * minted. The full key string is never persisted client-side beyond this
 * modal's lifetime — closing it loses the value forever.
 */
export function KeyRevealModal(props: {
  open: boolean;
  onClose: () => void;
  keyValue: string;
  title?: string;
}) {
  const copy = async () => {
    await navigator.clipboard.writeText(props.keyValue);
    toast.success('Copied to clipboard');
  };
  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title ?? 'Save this key now'}</DialogTitle>
          <DialogDescription>
            This is the <strong>only time</strong> you will see the full key value.
            Copy it now — once you close this dialog it's gone.
          </DialogDescription>
        </DialogHeader>
        <div className="bg-muted p-3 rounded font-mono text-sm break-all select-all">
          {props.keyValue}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={copy}>
            Copy
          </Button>
          <Button onClick={props.onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
