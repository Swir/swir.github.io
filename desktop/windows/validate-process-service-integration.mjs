import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const requireText = (text, needle, message) => {
  if (!text.includes(needle)) throw new Error(`${message} Missing: ${needle}`);
};
const forbidText = (text, needle, message) => {
  if (text.includes(needle)) throw new Error(`${message} Forbidden: ${needle}`);
};

const program = read('desktop/windows/Program.cs');
const permission = read('desktop/windows/PermissionBroker.cs');
const broker = read('desktop/windows/DesktopProcessServiceBroker.cs');

requireText(program, 'private readonly DesktopProcessServiceBroker _processServices = new();', 'Desktop Host must own the process/service broker.');
requireText(program, '"processes" => DispatchProcessesAsync(request.Method)', 'Desktop Host must route process inspection to the native broker.');
requireText(program, '"services" => DispatchServicesAsync(request.Method)', 'Desktop Host must route service inspection to the native broker.');
requireText(program, '"info" => _processServices.Describe()', 'Process/service info must come from the native broker.');
requireText(program, '"list" => _processServices.GetProcesses()', 'Process listing must come from the native broker.');
requireText(program, '"list" => _processServices.GetServices()', 'Service listing must come from the native broker.');
requireText(program, "nativeProcessService: true", 'Desktop Host must advertise native process/service support.');
requireText(program, "processes: surface('processes', ['info','list'])", 'Native process surface must remain read-only.');
requireText(program, "services: surface('services', ['info','list'])", 'Native service surface must remain read-only.');

requireText(permission, '"service.inspect"', 'Trusted shell must receive service.inspect.');
requireText(permission, '("processes", "info" or "list") => "process.inspect"', 'Process inspection must require process.inspect.');
requireText(permission, '("services", "info" or "list") => "service.inspect"', 'Service inspection must require service.inspect.');

requireText(broker, 'readOnly = true', 'Broker must declare read-only semantics.');
requireText(broker, 'processMutation = false', 'Broker must deny process mutation.');
requireText(broker, 'serviceMutation = false', 'Broker must deny service mutation.');
requireText(broker, 'commandLineExposure = false', 'Broker must deny command-line exposure.');
requireText(broker, 'executablePathExposure = false', 'Broker must deny executable path exposure.');
requireText(broker, 'environmentExposure = false', 'Broker must deny environment exposure.');

forbidText(program, "surface('services', ['start'", 'Service start must not be exposed before a privileged mutation contract exists.');
forbidText(program, "surface('services', ['stop'", 'Service stop must not be exposed before a privileged mutation contract exists.');
forbidText(program, "surface('processes', ['kill'", 'Process kill must not be exposed by the read-only native surface.');
forbidText(program, "surface('processes', ['spawn'", 'Process spawn must not be exposed by the read-only native surface.');

console.log('Desktop process/service Host integration contract: OK');
