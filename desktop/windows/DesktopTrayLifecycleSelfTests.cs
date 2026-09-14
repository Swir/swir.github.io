using Swir.Desktop.Host;

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

var lifecycle = new DesktopTrayLifecycle();
var initial = lifecycle.Describe();
Require(initial.Schema == DesktopTrayLifecycle.Schema, "invalid tray schema");
Require(initial.Enabled, "tray must be enabled");
Require(initial.WindowState == "visible", "tray lifecycle must start visible");
Require(initial.CanHide && !initial.CanRestore && initial.CanExit, "invalid visible capabilities");

Require(lifecycle.RequestHide(), "first hide transition must succeed");
Require(!lifecycle.RequestHide(), "duplicate hide transition must be idempotent");
var hidden = lifecycle.Describe();
Require(hidden.WindowState == "hidden", "hide transition failed");
Require(!hidden.CanHide && hidden.CanRestore && hidden.CanExit, "invalid hidden capabilities");

Require(lifecycle.RequestRestore(), "restore transition must succeed");
Require(!lifecycle.RequestRestore(), "duplicate restore transition must be idempotent");
var restored = lifecycle.Describe();
Require(restored.WindowState == "visible", "restore transition failed");

Require(lifecycle.RequestExit(), "exit transition must succeed");
Require(!lifecycle.RequestExit(), "duplicate exit transition must be rejected");
Require(!lifecycle.RequestHide(), "hide must be rejected after exit request");
Require(!lifecycle.RequestRestore(), "restore must be rejected after exit request");
var exiting = lifecycle.Describe();
Require(exiting.WindowState == "exiting", "exit state missing");
Require(!exiting.CanHide && !exiting.CanRestore && !exiting.CanExit, "exiting state must be terminal for requests");

lifecycle.MarkDisposed();
var disposed = lifecycle.Describe();
Require(disposed.WindowState == "disposed", "dispose state missing");
Require(!disposed.CanHide && !disposed.CanRestore && !disposed.CanExit, "disposed state must expose no actions");

Console.WriteLine("Desktop tray lifecycle self-tests passed.");
