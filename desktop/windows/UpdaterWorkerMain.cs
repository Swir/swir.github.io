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
            var plan = protocol.Prepare(state);

            Console.WriteLine(JsonSerializer.Serialize(new
            {
                schema = UpdaterWorkerProtocol.WorkerPlanSchema,
                transactionId = plan.TransactionId,
                currentVersion = plan.CurrentVersion.ToString(),
                targetVersion = plan.TargetVersion.ToString(),
                state = plan.State,
                currentRoot = plan.CurrentRoot,
                previousRoot = plan.PreviousRoot,
                candidateRoot = plan.CandidateRoot,
                planPath = plan.PlanPath,
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
        if (args.Length != 7 || !string.Equals(args[0], "plan", StringComparison.OrdinalIgnoreCase))
            throw new UpdateSecurityException(
                "UPDATE_WORKER_ARGS_INVALID",
                "Usage: SWIR.Desktop.UpdaterWorker plan --journal <path> --transactions-root <path> --deployment-root <path>");

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
        return new ParsedArgs(Path.GetFullPath(journal), Path.GetFullPath(transactionsRoot), Path.GetFullPath(deploymentRoot));
    }

    private sealed record ParsedArgs(string JournalPath, string TransactionsRoot, string DeploymentRoot);
}
