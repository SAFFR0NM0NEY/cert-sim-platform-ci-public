export type DeviceKind =
  | "router"
  | "switch"
  | "pc"
  | "server"
  | "phone"
  | "ap"
  | "laptop";
export type Cable = "copper" | "fiber" | "serial";
export type RadioMode = "mixed" | "a" | "b" | "g" | "n" | "ac";
export type RadioBand = "2.4" | "5";
export interface WirelessSettings {
  band?: RadioBand;
  mode?: RadioMode;
  ssid: string;
  security: "open" | "wpa2-personal";
  key?: string;
  channel?: number;
  range?: number;
  broadcast?: boolean;
}
export interface PortSecurity {
  sticky?: boolean;
  bindings?: { vlan: number; mac: string; sticky: boolean }[];
  vlanMaximums?: { vlan: number; maximum: number }[];
  agingMinutes?: number;
  ageStatic?: boolean;
  agingType?: "absolute" | "inactivity";
  maximum: number;
  violation: "protect" | "restrict" | "shutdown";
  addresses: string[];
}
export interface DhcpClientLease {
  tftp?: string;
  server: string;
  address: string;
  duration: number;
  expires: number;
  nextAttempt: number;
  state: "bound" | "renewing" | "rebinding";
}
export type VirtualInterface =
  | { kind: "subinterface"; parent: string; vlan?: number; native?: boolean }
  | { kind: "svi"; vlan: number }
  | { kind: "portchannel"; group: number };
export type ChannelMode = "on" | "active" | "passive" | "desirable" | "auto";
export type SwitchportMode =
  | "access"
  | "trunk"
  | "dynamic-auto"
  | "dynamic-desirable";
export interface Port {
  nonegotiate?: boolean;
  channelGroup?: { id: number; mode: ChannelMode };
  channelProtocol?: "lacp" | "pagp";
  portFast?: "default" | "enable" | "trunk" | "disable";
  bpduGuard?: "default" | "enable" | "disable";
  routed?: boolean;
  virtual?: VirtualInterface;
  dhcpLease?: DhcpClientLease;
  dhcpRetryAt?: number;
  slot?: 1 | 2;
  clockRate?: number;
  nativeVlan?: number;
  cdp?: boolean;
  lldpTransmit?: boolean;
  lldpReceive?: boolean;
  voiceVlan?: number;
  taggedVlan?: number;
  security?: PortSecurity;
  id: string;
  name: string;
  media: Cable | "radio";
  enabled: boolean;
  ip: string;
  prefix: number;
  vlan: number;
  mode: SwitchportMode;
  allowedVlans: number[];
  addressMode?: "static" | "dhcp";
  helperAddresses?: string[];
  inboundAcl?: string;
  outboundAcl?: string;
  cost?: number;
  /** Routing metric metadata in Kbps; does not change link speed. */
  bandwidth?: number;
  /** Routing metric metadata in tens of microseconds. */
  delay?: number;
  spanningTreeCost?: number;
  natRole?: "inside" | "outside";
  ipv6?: string;
  prefix6?: number;
}
export interface Route {
  network: string;
  prefix: number;
  nextHop: string;
}
export interface Route6 {
  network: string;
  prefix: number;
  nextHop: string;
  interface?: string;
}
export interface CallManager {
  address: string;
  lines: { mac: string; number: string }[];
}
export interface Vlan {
  id: number;
  name: string;
  state: "active" | "suspended";
}
export interface VtpConfig {
  mode: "server" | "client" | "transparent";
  domain: string;
  version: 1 | 2;
  revision: number;
  password?: string;
}
export interface Device {
  etherChannelLoadBalance?: "src-mac" | "dst-mac" | "src-dst-mac";
  bpduGuardRecovery?: boolean;
  vlans?: Vlan[];
  vtp?: VtpConfig;
  ipRouting?: boolean;
  wireless?: WirelessSettings;
  securityRecovery?: { enabled: boolean; interval: number };
  callManager?: CallManager;
  managerAddress?: string;
  cdp?: boolean;
  lldp?: boolean;
  id: string;
  name: string;
  kind: DeviceKind;
  x: number;
  y: number;
  powered: boolean;
  gateway: string;
  ports: Port[];
  routes: Route[];
  note: string;
  dns?: string;
  services?: ServerServices;
  routing?: RoutingConfig;
  accessLists?: AccessList[];
  gateway6?: string;
  ipv6Routing?: boolean;
  routes6?: Route6[];
  startupConfig?: DeviceConfiguration;
  spanningTree?: {
    priorities: { vlan: number; priority: number }[];
    portFastDefault?: boolean;
    bpduGuardDefault?: boolean;
  };
  macAgingSeconds?: number;
  staticMac?: { vlan: number; mac: string; port: string }[];
  nat?: NatConfig;
}
export type DeviceConfiguration = Pick<
  Device,
  | "name"
  | "gateway"
  | "ports"
  | "routes"
  | "dns"
  | "services"
  | "routing"
  | "accessLists"
  | "gateway6"
  | "ipv6Routing"
  | "ipRouting"
  | "vlans"
  | "vtp"
  | "routes6"
  | "spanningTree"
  | "macAgingSeconds"
  | "staticMac"
  | "nat"
  | "wireless"
  | "securityRecovery"
  | "bpduGuardRecovery"
  | "etherChannelLoadBalance"
  | "callManager"
  | "managerAddress"
  | "cdp"
  | "lldp"
>;
export interface NatConfig {
  hairpin?: boolean;
  static: { inside: string; outside: string }[];
  overload: { acl: string; outsidePort: string }[];
  pools?: NatPool[];
  poolRules?: { acl: string; pool: string; overload: boolean }[];
  portForwards?: {
    protocol: "tcp" | "udp";
    inside: string;
    insidePort: number;
    outside: string;
    outsidePort: number;
  }[];
}
export interface NatPool {
  name: string;
  start: string;
  end: string;
  prefix: number;
}
export interface Endpoint {
  device: string;
  port: string;
}
export interface Link {
  dce?: "a" | "b";
  id: string;
  a: Endpoint;
  b: Endpoint;
  cable: Cable;
  lengthMeters?: number;
}
export interface PduScenario {
  id: string;
  name: string;
  description: string;
}
export interface UserPdu {
  sourceInterface?: string;
  ttl?: number;
  scenario?: string;
  schedule?: { delay: number; interval?: number };
  id: string;
  source: string;
  target: string;
  port: string;
  protocol: "icmp" | "icmpv6" | "tcp" | "udp";
  destinationPort?: number;
}
export type ActivityField = "enabled" | "ipv4" | "vlan" | "band";
export interface InterfaceCheck {
  device: string;
  port: string;
  field: ActivityField;
  expected: string;
}
export interface PracticeActivity {
  interfaceChecks?: InterfaceCheck[];
  title: string;
  instructions: string;
  initial: Omit<Topology, "activity">;
  checks: { probe: UserPdu; deliver: boolean }[];
}
export type NativeDocumentFormat = "pkt" | "pka";
export interface PackageResource {
  name: string;
  size: number;
}
export interface PackageBackground {
  name: string;
  tiled: boolean;
}
export type NativeFile = {
  key: string;
  name: string;
  pages: string[];
} & (
  | { format: NativeDocumentFormat }
  | {
      format: "pkz";
      documentFormat: NativeDocumentFormat;
      resources: PackageResource[];
      background?: PackageBackground;
    }
);
export interface PackageEdits {
  add: (PackageResource & { key: string })[];
  remove: string[];
  background?: PackageBackground | null;
}
export interface Topology {
  dhcpTime?: number;
  nativeFile?: NativeFile;
  packageEdits?: PackageEdits;
  activity?: PracticeActivity;
  scenarios?: PduScenario[];
  activeScenario?: string;
  pdus?: UserPdu[];
  version: 1;
  name: string;
  devices: Device[];
  links: Link[];
  physical?: PhysicalLayout;
  annotations?: Annotation[];
}
export type AnnotationKind = "note" | "line" | "rectangle" | "ellipse";
export interface Annotation {
  id: string;
  kind: AnnotationKind;
  x: number;
  y: number;
  x2: number;
  y2: number;
  text: string;
  color: string;
  fill: string;
  fontSize: number;
}
export interface PhysicalLocation {
  id: string;
  name: string;
  kind: "city" | "building" | "closet";
  parent: string | null;
}
export interface Placement {
  device: string;
  location: string;
  unit: number;
}
export interface PhysicalLayout {
  locations: PhysicalLocation[];
  placements: Placement[];
}
export interface PacketEvent {
  link?: string;
  id: number;
  protocol:
    | "ARP"
    | "ICMP"
    | "DROP"
    | "DHCP"
    | "DNS"
    | "TCP"
    | "UDP"
    | "HTTP"
    | "ACL"
    | "RIP"
    | "OSPF"
    | "ICMPv6"
    | "NDP"
    | "NAT"
    | "SCCP"
    | "RTP";
  from: string;
  to: string;
  detail: string;
  phase: "request" | "reply";
  ttl: number;
  layer: 2 | 3 | 4 | 7;
}
export interface PingResult {
  ok: boolean;
  message: string;
  events: PacketEvent[];
  hops: string[];
  destinationDevice?: string;
  destinationAddress?: string;
  destinationPort?: number;
}
export interface CliSession {
  portIds?: string[];
  mode: "user" | "privileged" | "config" | "interface" | "routing" | "vlan";
  vlanIds?: number[];
  portId: string | null;
}
export interface DhcpPool {
  leaseSeconds?: number;
  tftp?: string;
  id: string;
  name: string;
  start: string;
  prefix: number;
  count: number;
  gateway: string;
  dns: string;
}
export interface DhcpLease {
  expires?: number;
  serverAddress?: string;
  tftp?: string;
  pool: string;
  client: string;
  port: string;
  ip: string;
}
export type DnsAddressType = "A" | "AAAA";
export interface DnsRecord {
  ttl?: number;
  name: string;
  type: DnsAddressType | "CNAME";
  value: string;
}
export interface ServerServices {
  dhcp: { enabled: boolean; pools: DhcpPool[]; leases: DhcpLease[] };
  dns: { enabled: boolean; records: DnsRecord[] };
  http: { enabled: boolean; pages: { path: string; body: string }[] };
}
export interface RoutingConfig {
  protocol: "none" | "rip" | "ospf" | "eigrp";
  processId: number;
  routerId: string;
  networks: { network: string; prefix: number; area: number }[];
  passivePorts: string[];
}
export interface AccessRule {
  action: "permit" | "deny";
  protocol: "ip" | "icmp" | "tcp" | "udp";
  source: string;
  sourcePrefix: number;
  destination: string;
  destinationPrefix: number;
  destinationPort?: number;
}
export interface AccessList {
  name: string;
  rules: AccessRule[];
}
export interface PacketContext {
  protocol: "icmp" | "tcp" | "udp";
  sourceIp: string;
  destinationIp: string;
  sourcePort?: number;
  destinationPort?: number;
}
export interface LearnedRoute extends Route {
  protocol: "rip" | "ospf" | "eigrp";
  localPort?: string;
  distance: number;
  metric: number;
  learnedFrom: string;
}
