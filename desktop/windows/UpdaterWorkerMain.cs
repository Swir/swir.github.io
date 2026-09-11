using System.Text.Json;
using Swir.Desktop.Host;

internal static class UpdaterWorkerMain
{
    private static int Main(string[] args)
    {
        try
        {
            var parsed = ParseArgs(args);
            var journal = new UpdateTransactionJournal(parsed.TransactionsRoot);
            var state = journal.Read(parsed.JournalPath);
            var protocol = new UpdaterWorkerProtocol(journal, parsed.DeploymentRoot);

            if (string.Equals(parsed.Command, "recover", StringComparison.OrdinalIgnoreCase))
            {
                var planPath = Path.Combine(
                    Path.GetDirectoryName(Path.GetFullPath(parsed.JournalPath))
                        ?? throw new UpdateSecurityException("UPDATE_WORKER_PLAN_PATH_INVALID", "Transaction journal directory is invalid."),
                    "worker-plan.json");
                var plan = protocol.Read(planPath, state);
                var activator = new DeploymentSlotActivator(journal);
                var health = new UpdateHealthBroker(journal);
                var recovery = new UpdateRecoveryCoordinator(journal, health, activator).Recover(plan);
                Console.WriteLine(JsonSerializer.Serialize(new
                {
                    schema = "swir.desktop-updater-recovery/0.1",
                    transactionId = recovery.TransactionId,
                    state = recovery.State,
                    action = recovery.Action,
                    changed = recovery.Changed,
                    journalPath = recovery.JournalPath,
                    executableActionsEnabled = false
                }));
                return 0;
            }

            var preparedPlan = protocol.Prepare(state);
            if (string.Equals(parsed.Command, "prepare-candidate", StringComparison.OrdinalIgnoreCase))
            {
                var candidate = new CandidatePackagePreparer().Prepare(preparedPlan);
                Console.WriteLine(JsonSerializer.Serialize(new
                {
                    schema = CandidatePackagePreparer.CandidateStateSchema,
                    transactionId = candidate.TransactionId,
                    targetVersion = candidate.TargetVersion,
                    state = "candidate-prepared",
                    payloadRoot = candidate.PayloadRoot,
                    entryPoint = candidate.EntryPoint,
                    fileCount = candidate.FileCount,
                    expandedBytes = candidate.ExpandedBytes,
                    candidateStatePath = candidate.StatePath,
                    executableActionsEnabled = false
                }));
                return 0;
            }

            if (string.Equals(parsed.Command, "activate-and-launch", StringComparison.OrdinalIgnoreCase))
            {
                var candidatePreparer = new CandidatePackagePreparer();
                var candidateStatePath = Path.Combine(Path.GetFullPath(preparedPlan.CandidateRoot), "candidate-state.json");
                var candidate = candidatePreparer.ReadAndVerify(preparedPlan, candidateStatePath);

                var activator = new DeploymentSlotActivator(journal, candidatePreparer);
                var health = new UpdateHealthBroker(journal);
                var activationCoordinator = new UpdateActivationCoordinator(journal, activator, health);
                var ready = activationCoordinator.ActivateAndIssueHealth(preparedPlan, candidate);

                // Launch is intentionally performed only after the candidate has been
                // re-verified, atomically promoted and bound to a persisted health challenge.
                // ControlledCandidateLauncher rolls back to Previous on start failure or
                // an early process exit; the raw health token is never written to stdout.
                var launcher = new ControlledCandidateLauncher(journal, activator);
                var launch = launcher.Launch(preparedPlan, candidate, ready);

                Console.WriteLine(JsonSerializer.Serialize(new
                {
                    schema = ControlledCandidateLauncher.LaunchSchema,
                    transactionId = launch.TransactionId,
                    targetVersion = launch.TargetVersion,
                    state = launch.Phase,
                    processId = launch.ProcessId,
                    entryPoint = launch.EntryPoint,
                    startedAt = launch.StartedAt,
                    launchPath = launch.LaunchPath,
                    journalPath = parsed.JournalPath,
                    executableActionsEnabled = true,
                    healthTokenPersisted = false
                }));
                return 0;
            }

            Console.WriteLine(JsonSerializer.Serialize(new
            {
                schema = UpdaterWorkerProtocol.WorkerPlanSchema,
                transactionId = preparedPlan.TransactionId,
                currentVersion = preparedPlan.CurrentVersion.ToString(),
                targetVersion = preparedPlan.TargetVersion.ToString(),
                state = preparedPlan.State,
                currentRoot = preparedPlan.CurrentRoot,
                previousRoot = preparedPlan.PreviousRoot,
                candidateRoot = preparedPlan.CandidateRoot,
                planPath = preparedPlan.PlanPath,
                executableActionsEnabled = false
            }));
            return 0;
        }
        catch (UpdateSecurityException ex)
        {
            Console.Error.WriteLine($"SWIR updater worker blocked: {ex.Code}: {ex.Message}");
            return 2;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"SWIR updater worker failed: {ex.GetType().Name}: {ex.Message}");
            return 1;
        }
    }

    private static ParsedArgs ParseArgs(string[] args)
    {
        if (args.Length != 7
            || (!string.Equals(args[0], "plan", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(args[0], "prepare-candidate", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(args[0], "activate-and-launch", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(args[0], "recover", StringComparison.OrdinalIgnoreCase)))
            throw new UpdateSecurityException(
                "UPDATE_WORKER_ARGS_INVALID",
                "Usage: SWIR.Desktop.UpdaterWorker <plan|prepare-candidate|activate-and-launch|recover> --journal <path> --transactions-root <path> --deployment-root <path>");

        string? journal = null;
        string? transactionsRoot = null;
        string? deploymentRoot = null;
        for (var i = 1; i < args.Length; i += 2)
        {
            if (i + 1 >= args.Length)
                throw new UpdateSecurityException("UPDATE_WORKER_ARGS_INVALID", "Updater worker argument is missing a value.");
            switch (args[i])
            {
                case "--journal": journal = args[i + 1]; break;
                case "--transactions-root": transactionsRoot = args[i + 1]; break;
                case "--deployment-root": deploymentRoot = args[i + 1]; break;
                default: throw new UpdateSecurityException("UPDATE_WORKER_ARGS_INVALID", $"Unknown updater worker argument: {args[i]}");
            }
        }

        if (string.IsNullOrWhiteSpace(journal) || string.IsNullOrWhiteSpace(transactionsRoot) || string.IsNullOrWhiteSpace(deploymentRoot))
            throw new UpdateSecurityException("UPDATE_WORKER_ARGS_INVALID", "Updater worker requires journal, transactions root and deployment root.");
        return new ParsedArgs(args[0], Path.GetFullPath(journal), Path.GetFullPath(transactionsRoot), Path.GetFullPath(deploymentRoot));
    }

    private sealed record ParsedArgs(string Command, string JournalPath, string TransactionsRoot, string DeploymentRoot);
}
