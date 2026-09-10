export const ACCESS: Record<string, [string,string]> = {
  'remote.files.read': ['Read files', 'Read files and directories accessible to your SSH account on this machine.'],
  'remote.files.write': ['Change files', 'Create, modify, copy, move, and delete files accessible to your SSH account.'],
  'remote.exec': ['Run commands', 'Run arbitrary commands as your SSH user. Commands can also access files and the network.'],
  'remote.sudo': ['Run administrator commands', 'Request your administrator password for elevated commands. This grants broad control of the remote machine.'],
  'remote.dbus': ['Access system services', 'Read and call remote D-Bus services, including methods that change system state.'],
  'remote.system': ['Read system information', 'Read processes, services, ports, and machine time.'],
  'remote.tunnels': ['Create SSH tunnels', 'Expose remote services on local ports while this app is open.'],
  'desktop.openUrl': ['Open linked tools', 'Open its forwarded services in your browser or request another SSHDesk app.'],
  'desktop.embed': ['Embed a remote web app', 'Display content from its SSH tunnels inside this window.'],
  'network': ['Access the network', 'Send and receive data over HTTP and WebSockets, including data this app can read.'],
}
