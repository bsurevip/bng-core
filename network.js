/*jslint node: true */
"use strict";
var WebSocket = process.browser ? global.WebSocket : require('ws');
var WebSocketServer = WebSocket.Server;
var crypto = require('crypto');
var _ = require('lodash');
var async = require('async');
var db = require('./db.js');
var constants = require('./constants.js');
var storage = require('./storage.js');
var myWitnesses = require('./my_witnesses.js');
var joint_storage = require('./joint_storage.js');
var validation = require('./validation.js');
var ValidationUtils = require("./validation_utils.js");
var writer = require('./writer.js');
var conf = require('./conf.js');
var mutex = require('./mutex.js');
var catchup = require('./catchup.js');
var privatePayment = require('./private_payment.js');
var objectHash = require('./object_hash.js');
var ecdsaSig = require('./signature.js');
var eventBus = require('./event_bus.js');
var light = require('./light.js');
var mail = require('./mail.js'+'');

var MAX_INBOUND_CONNECTIONS = 10;
var MAX_OUTBOUND_CONNECTIONS = 10;
var MAX_TOLERATED_INVALID_RATIO = 0.1;
var MIN_COUNT_GOOD_PEERS = 10;
var FORWARDING_TIMEOUT = 10*1000; // don't forward if the joint was received more than FORWARDING_TIMEOUT ms ago
var STALLED_TIMEOUT = 5000; // a request is treated as stalled if no response received within STALLED_TIMEOUT ms
var RESPONSE_TIMEOUT = 300*1000; // after this timeout, the request is abandoned
var HEARTBEAT_TIMEOUT = 10*1000;

var wss;
var arrOutboundPeers = [];
var assocConnectingOutboundWebsockets = {};
var assocUnitsInWork = {};
var assocRequestedUnits = {};
var bCatchingUp = false;
var bWaitingTillIdle = false;
var coming_online_time = Date.now();
var assocReroutedConnectionsByTag = {};

var arrWatchedAddresses = [];

if (process.browser){ // browser
	console.log("defining .on() on ws");
	WebSocket.prototype.on = function(event, callback) {
		var self = this;
		if (event === 'message'){
			this['on'+event] = function(event){
				callback.call(self, event.data);
			};
			return;
		}
		if (event !== 'open'){
			this['on'+event] = callback;
			return;
		}
		// allow several handlers for 'open' event
		if (!this['open_handlers'])
			this['open_handlers'] = [];
		this['open_handlers'].push(callback);
		this['on'+event] = function(){
			self['open_handlers'].forEach(function(cb){
				cb();
			});
		};
	};
}

// if not using a hub and accepting messages directly (be your own hub)
var my_device_address;
var objMyTempPubkeyPackage;

function setMyDeviceProps(device_address, objTempPubkey){
	my_device_address = device_address;
	objMyTempPubkeyPackage = objTempPubkey;
}

exports.light_vendor_url = null;

// general network functions

function sendMessage(ws, type, content) {
	if (ws.readyState !== ws.OPEN){
		console.log("readyState="+ws.readyState);
		return;
	}
	var message = JSON.stringify([type, content]);
	console.log("SENDING "+message+" to "+ws.peer);
	ws.send(message);
}

function sendJustsaying(ws, subject, body){
	sendMessage(ws, 'justsaying', {subject: subject, body: body});
}

function sendError(ws, error) {
	sendJustsaying(ws, 'error', error);
}

function sendInfo(ws, content) {
	sendJustsaying(ws, 'info', content);
}

function sendResult(ws, content) {
	sendJustsaying(ws, 'result', content);
}

function sendErrorResult(ws, unit, error) {
	sendResult(ws, {unit: unit, result: 'error', error: error});
}

function sendVersion(ws){
	sendJustsaying(ws, 'version', {
		protocol_version: constants.version, 
		alt: constants.alt, 
		program: constants.program, 
		program_version: constants.program_version
	});
}

function sendResponse(ws, tag, response){
	delete ws.assocInPreparingResponse[tag];
	sendMessage(ws, 'response', {tag: tag, response: response});
}

function sendErrorResponse(ws, tag, error) {
	sendResponse(ws, tag, {error: error});
}

// if a 2nd identical request is issued before we receive a response to the 1st request, then:
// 1. its responseHandler will be called too but no second request will be sent to the wire
// 2. bReroutable flag must be the same
function sendRequest(ws, command, params, bReroutable, responseHandler){
	var request = {command: command};
	if (params)
		request.params = params;
	var content = _.clone(request);
	var tag = objectHash.getBase64Hash(request);
	//if (ws.assocPendingRequests[tag]) // ignore duplicate requests while still waiting for response from the same peer
	//    return console.log("will not send identical "+command+" request");
	if (ws.assocPendingRequests[tag])
		ws.assocPendingRequests[tag].responseHandlers.push(responseHandler);
	else{
		content.tag = tag;
		// after STALLED_TIMEOUT, reroute the request to another peer
		// it'll work correctly even if the current peer is already disconnected when the timeout fires
		var reroute = !bReroutable ? null : function(){
			console.log('will try to reroute a request stalled at '+ws.peer);
			findNextPeer(ws, function(next_ws){
				if (next_ws === ws)
					return;
				console.log('rerouting from '+ws.peer+' to '+next_ws.peer);
				ws.assocPendingRequests[tag].responseHandlers.forEach(function(rh){
					sendRequest(next_ws, command, params, bReroutable, rh);
				});
				if (!assocReroutedConnectionsByTag[tag])
					assocReroutedConnectionsByTag[tag] = [ws];
				assocReroutedConnectionsByTag[tag].push(next_ws);
				ws.assocPendingRequests[tag].bRerouted = true;
			});
		};
		var reroute_timer = !bReroutable ? null : setTimeout(reroute, STALLED_TIMEOUT);
		var cancel_timer = setTimeout(function(){
			// useless as STALLED_TIMEOUT is always less than RESPONSE_TIMEOUT
			//clearTimeout(ws.assocPendingRequests[tag].reroute_timer);
			ws.assocPendingRequests[tag].responseHandlers.forEach(function(rh){
				rh(ws, request, {error: "[internal] response timeout"});
			});
			delete ws.assocPendingRequests[tag];
		}, RESPONSE_TIMEOUT);
		ws.assocPendingRequests[tag] = {
			request: request,
			responseHandlers: [responseHandler], 
			reroute: reroute,
			reroute_timer: reroute_timer,
			cancel_timer: cancel_timer
		};
		sendMessage(ws, 'request', content);
	}
}

function handleResponse(ws, tag, response){
	var pendingRequest = ws.assocPendingRequests[tag];
	if (!pendingRequest) // was canceled due to timeout
		//throw "no req by tag "+tag;
		return console.log("no req by tag "+tag);
	pendingRequest.responseHandlers.forEach(function(responseHandler){
		responseHandler(ws, pendingRequest.request, response);
	});
	
	clearTimeout(pendingRequest.reroute_timer);
	clearTimeout(pendingRequest.cancel_timer);
	delete ws.assocPendingRequests[tag];
	
	// if the request was rerouted, cancel all other pending requests
	if (assocReroutedConnectionsByTag[tag]){
		assocReroutedConnectionsByTag[tag].forEach(function(client){
			if (client.assocPendingRequests[tag]){
				clearTimeout(client.assocPendingRequests[tag].reroute_timer);
				clearTimeout(client.assocPendingRequests[tag].cancel_timer);
				delete client.assocPendingRequests[tag];
			}
		});
		delete assocReroutedConnectionsByTag[tag];
	}
}

function cancelRequestsOnClosedConnection(ws){
	console.log("websocket closed, will complete all outstanding requests");
	for (var tag in ws.assocPendingRequests){
		var pendingRequest = ws.assocPendingRequests[tag];
		clearTimeout(pendingRequest.reroute_timer);
		clearTimeout(pendingRequest.cancel_timer);
		if (pendingRequest.reroute){ // reroute immediately, not waiting for STALLED_TIMEOUT
			if (!pendingRequest.bRerouted)
				pendingRequest.reroute();
		}
		else
			pendingRequest.responseHandlers.forEach(function(rh){
				rh(ws, pendingRequest.request, {error: "[internal] connection closed"});
			});
		delete ws.assocPendingRequests[tag];
	}
}



// peers

function findNextPeer(ws, handleNextPeer){
	var arrOutboundSources = arrOutboundPeers.filter(function(outbound_ws){ return outbound_ws.bSource; });
	var len = arrOutboundSources.length;
	if (len === 0)
		return findRandomInboundPeer(handleNextPeer);
	var peer_index = arrOutboundSources.indexOf(ws); // -1 if it is already disconnected by now, or if it is inbound peer, or if it is null
	var next_peer_index = (peer_index === -1) ? getRandomInt(0, len-1) : ((peer_index+1)%len);
	handleNextPeer(arrOutboundSources[next_peer_index]);
}

function getRandomInt(min, max) {
	return Math.floor(Math.random() * (max+1 - min)) + min;
}

function findRandomInboundPeer(handleInboundPeer){
	var arrInboundSources = wss.clients.filter(function(inbound_ws){ return inbound_ws.bSource; });
	if (arrInboundSources.length === 0)
		return;
	var arrInboundHosts = arrInboundSources.map(function(ws){ return ws.host; });
	// filter only those inbound peers that are reversible
	db.query(
		"SELECT peer_host FROM peer_host_urls JOIN peer_hosts USING(peer_host) \n\
		WHERE is_active=1 AND peer_host IN(?) \n\
			AND (count_invalid_joints/count_new_good_joints<? \n\
			OR count_new_good_joints=0 AND count_nonserial_joints=0 AND count_invalid_joints=0) \n\
		ORDER BY (count_new_good_joints=0), "+db.getRandom()+" LIMIT 1", 
		[arrInboundHosts, MAX_TOLERATED_INVALID_RATIO], 
		function(rows){
			console.log(rows.length+" inbound peers");
			if (rows.length === 0)
				return;
			var host = rows[0].peer_host;
			console.log("selected inbound peer "+host);
			var ws = arrInboundSources.filter(function(ws){ return (ws.host === host); })[0];
			if (!ws)
				throw "inbound ws not found";
			handleInboundPeer(ws);
		}
	);
}

function checkIfHaveEnoughOutboundPeersAndAdd(){
	var arrOutboundPeerUrls = arrOutboundPeers.map(function(ws){ return ws.peer; });
	db.query(
		"SELECT peer FROM peers JOIN peer_hosts USING(peer_host) \n\
		WHERE count_new_good_joints>0 AND count_invalid_joints/count_new_good_joints<? AND peer IN(?)", 
		[MAX_TOLERATED_INVALID_RATIO, (arrOutboundPeerUrls.length > 0) ? arrOutboundPeerUrls : null],
		function(rows){
			var count_good_peers = rows.length;
			if (count_good_peers >= MIN_COUNT_GOOD_PEERS)
				return;
			if (count_good_peers === 0) // nobody trusted enough to ask for new peers, can't do anything
				return;
			var arrGoodPeerUrls = rows.map(function(row){ return row.peer; });
			for (var i=0; i<arrOutboundPeers.length; i++){
				var ws = arrOutboundPeers[i];
				if (arrGoodPeerUrls.indexOf(ws.peer) !== -1)
					requestPeers(ws);
			}
		}
	);
}

function connectToPeer(url, onOpen) {
	addPeer(url);
	var ws = new WebSocket(url);
	assocConnectingOutboundWebsockets[url] = ws;
	setTimeout(function(){
		delete assocConnectingOutboundWebsockets[url];
	}, 5000);
	ws.on('open', function () {
		delete assocConnectingOutboundWebsockets[url];
		if (!ws.url)
			throw Error("no url on ws");
		if (ws.url !== url && ws.url !== url + "/") // browser implementatin of Websocket might add /
			throw Error("url is different: "+ws.url);
		ws.peer = url;
		ws.host = getHostByPeer(ws.peer);
		ws.assocPendingRequests = {};
		ws.assocInPreparingResponse = {};
		ws.bOutbound = true;
		ws.last_ts = Date.now();
		console.log('connected to '+url+", host "+ws.host);
		arrOutboundPeers.push(ws);
		sendVersion(ws);
		if (conf.myUrl) // I can listen too, this is my url to connect to
			sendJustsaying(ws, 'my_url', conf.myUrl);
		if (!conf.bLight)
			subscribe(ws);
		if (onOpen)
			onOpen(null, ws);
	});
	ws.on('close', function() {
		var i = arrOutboundPeers.indexOf(ws);
		console.log('removing '+i+': '+url);
		if (i !== -1)
			arrOutboundPeers.splice(i, 1);
		cancelRequestsOnClosedConnection(ws);
	});
	ws.on('error', function(e){
		delete assocConnectingOutboundWebsockets[url];
		console.log("error from server "+url+": "+e);
		// !ws.bOutbound means not connected yet. This is to distinguish connection errors from later errors that occur on open connection
		if (!ws.bOutbound && onOpen)
			onOpen(JSON.stringify(e));
	});
	ws.on('message', onWebsocketMessage);
	console.log('connectToPeer done');
}

function addOutboundPeers(multiplier){
	if (!multiplier)
		multiplier = 1;
	if (multiplier >= 32) // limit recursion
		return;
	var order_by = (multiplier <= 4) ? "count_new_good_joints DESC" : db.getRandom(); // don't stick to old peers with most accumulated good joints
	var arrOutboundPeerUrls = arrOutboundPeers.map(function(ws){ return ws.peer; });
	var arrInboundHosts = wss.clients.map(function(ws){ return ws.host; });
	var max_new_outbound_peers = MAX_OUTBOUND_CONNECTIONS-arrOutboundPeerUrls.length;
	if (max_new_outbound_peers <= 0)
		return;
	db.query(
		"SELECT peer \n\
		FROM peers \n\
		JOIN peer_hosts USING(peer_host) \n\
		LEFT JOIN peer_host_urls ON peer=url AND is_active=1 \n\
		WHERE (count_invalid_joints/count_new_good_joints<? \n\
			OR count_new_good_joints=0 AND count_nonserial_joints=0 AND count_invalid_joints=0) \n\
			"+((arrOutboundPeerUrls.length > 0) ? "AND peer NOT IN("+db.escape(arrOutboundPeerUrls)+") \n" : "")+"\n\
			"+((arrInboundHosts.length > 0) ? "AND (peer_host_urls.peer_host IS NULL OR peer_host_urls.peer_host NOT IN("+db.escape(arrInboundHosts)+")) \n": "")+"\n\
			AND is_self=0 \n\
		ORDER BY "+order_by+" LIMIT ?", 
		[MAX_TOLERATED_INVALID_RATIO*multiplier, max_new_outbound_peers], 
		function(rows){
			for (var i=0; i<rows.length; i++)
				findOutboundPeerOrConnect(rows[i].peer);
			if (arrOutboundPeerUrls.length === 0 && rows.length === 0) // if no outbound connections at all, get less strict
				addOutboundPeers(multiplier*2);
		}
	);
}

function getHostByPeer(peer){
	var matches = peer.match(/^wss?:\/\/(.*)$/i);
	if (matches)
		peer = matches[1];
	matches = peer.match(/^(.*?)[:\/]/);
	return matches ? matches[1] : peer;
}

function addPeerHost(host, onDone){
	db.query("INSERT "+db.getIgnore()+" INTO peer_hosts (peer_host) VALUES (?)", [host], function(){
		if (onDone)
			onDone();
	});
}

function addPeer(peer){
	var host = getHostByPeer(peer);
	addPeerHost(host, function(){
		console.log("will insert peer "+peer);
		db.query("INSERT "+db.getIgnore()+" INTO peers (peer_host, peer) VALUES (?,?)", [host, peer]);
	});
}

function getOutboundPeerWsByUrl(url){
	console.log("outbound peers: "+arrOutboundPeers.map(function(o){ return o.peer; }).join(", "));
	for (var i=0; i<arrOutboundPeers.length; i++)
		if (arrOutboundPeers[i].peer === url)
			return arrOutboundPeers[i];
	return null;
}

function getPeerWebSocket(peer){
	for (var i=0; i<arrOutboundPeers.length; i++)
		if (arrOutboundPeers[i].peer === peer)
			return arrOutboundPeers[i];
	for (var i=0; i<wss.clients.length; i++)
		if (wss.clients[i].peer === peer)
			return wss.clients[i];
	return null;
}

function findOutboundPeerOrConnect(url, onOpen){
	if (!onOpen)
		onOpen = function(){};
	var ws = getOutboundPeerWsByUrl(url);
	if (ws)
		return onOpen(null, ws);
	// check if we are already connecting to the peer
	ws = assocConnectingOutboundWebsockets[url];
	if (ws){ // add second event handler
		console.log("already connecting to "+url);
		return ws.on('open', function(){ onOpen(null, ws); });
	}
	console.log("will connect to "+url);
	connectToPeer(url, onOpen);
}

function requestPeers(ws){
	sendRequest(ws, 'get_peers', null, false, handleNewPeers);
}

function handleNewPeers(ws, request, arrPeerUrls){
	if (!Array.isArray(arrPeerUrls))
		return sendError(ws, "peer urls is not an array");
	var arrQueries = [];
	for (var i=0; i<arrPeerUrls.length; i++){
		var url = arrPeerUrls[i];
		if (conf.myUrl && conf.myUrl.toLowerCase() === url.toLowerCase())
			continue;
		var host = getHostByPeer(url);
		db.addQuery(arrQueries, "INSERT "+db.getIgnore()+" INTO peer_hosts (peer_host) VALUES (?)", [host]);
		db.addQuery(arrQueries, "INSERT "+db.getIgnore()+" INTO peers (peer_host, peer, learnt_from_peer_host) VALUES(?,?,?)", [host, url, ws.host]);
	}
	async.series(arrQueries);
}

function heartbeat(){
	wss.clients.concat(arrOutboundPeers).forEach(function(ws){
		var elapsed_since_last_received = Date.now() - ws.last_ts;
		if (elapsed_since_last_received < HEARTBEAT_TIMEOUT)
			return;
		if (elapsed_since_last_received < 2*HEARTBEAT_TIMEOUT)
			return sendRequest(ws, 'heartbeat', null, false, function(){});
		ws.close(1000, "lost connection");
	});
}

function requestFromLightVendor(command, params, responseHandler){
	if (!exports.light_vendor_url){
		console.log("light_vendor_url not set yet");
		return setTimeout(function(){
			requestFromLightVendor(command, params, responseHandler);
		}, 1000);
	}
	findOutboundPeerOrConnect(exports.light_vendor_url, function(err, ws){
		if (err)
			return responseHandler(null, null, {error: "[connect to light vendor failed]: "+err});
		sendRequest(ws, command, params, false, responseHandler);
	});
}

function printConnectionStatus(){
	console.log(wss.clients.length+" incoming connections, "+arrOutboundPeers.length+" outgoing connections, "+
		Object.keys(assocConnectingOutboundWebsockets).length+" outgoing connections being opened");
}

function subscribe(ws){
	ws.subscription_id = crypto.randomBytes(30).toString("base64"); // this is to detect self-connect
	storage.readLastMainChainIndex(function(last_mci){
		sendRequest(ws, 'subscribe', {subscription_id: ws.subscription_id, last_mci: last_mci}, false, function(ws, request, response){
			if (!response.error)
				ws.bSource = true;
			delete ws.subscription_id;
		});
	});
}

// joints

// sent as justsaying or as response to a request
function sendJoint(ws, objJoint, tag) {
	console.log('sending joint identified by unit ' + objJoint.unit.unit + ' to', ws.peer);
	tag ? sendResponse(ws, tag, {joint: objJoint}) : sendJustsaying(ws, 'joint', objJoint);
}

// sent by light clients to their vendors
function postJointToLightVendor(objJoint, handleResponse) {
	console.log('posing joint identified by unit ' + objJoint.unit.unit + ' to light vendor');
	requestFromLightVendor('post_joint', objJoint, function(ws, request, response){
		handleResponse(response);
	});
}

function sendFreeJoints(ws) {
	storage.readFreeJoints(function(objJoint){
		sendJoint(ws, objJoint);
	}, function(){
		sendJustsaying(ws, 'free_joints_end', null);
	});
}

function sendJointsSinceMci(ws, mci) {
	joint_storage.readJointsSinceMci(
		mci, 
		function(objJoint){
			sendJoint(ws, objJoint);
		},
		function(){
			sendJustsaying(ws, 'free_joints_end', null);
		}
	);
}

function requestFreeJointsFromAllOutboundPeers(){
	for (var i=0; i<arrOutboundPeers.length; i++)
		sendJustsaying(arrOutboundPeers[i], 'refresh', null);
}

function requestNewJoints(ws){
	storage.readLastMainChainIndex(function(last_mci){
		sendJustsaying(ws, 'refresh', last_mci);
	});
}

function rerequestLostJoints(){
	//console.log("rerequestLostJoints");
	if (bCatchingUp)
		return;
	joint_storage.findLostJoints(function(arrUnits){
		console.log("lost units", arrUnits);
		findNextPeer(null, function(ws){
			console.log("found next peer "+ws.peer);
			requestJoints(ws, arrUnits.filter(function(unit){ return (!assocUnitsInWork[unit] && !havePendingJointRequest(unit)); }));
		});
	});
}

function requestNewMissingJoints(ws, arrUnits){
	var arrNewUnits = [];
	async.eachSeries(
		arrUnits,
		function(unit, cb){
			if (assocUnitsInWork[unit])
				return cb();
			if (havePendingJointRequest(unit)){
				console.log("unit "+unit+" was already requested");
				return cb();
			}
			joint_storage.checkIfNewUnit(unit, {
				ifNew: function(){
					arrNewUnits.push(unit);
					cb();
				},
				ifKnown: function(){console.log("known"); cb();}, // it has just been handled
				ifKnownUnverified: function(){console.log("known unverified"); cb();} // I was already waiting for it
			});
		},
		function(){
			//console.log(arrNewUnits.length+" of "+arrUnits.length+" left", assocUnitsInWork);
			// filter again as something could have changed each time we were paused in checkIfNewUnit
			arrNewUnits = arrNewUnits.filter(function(unit){ return (!assocUnitsInWork[unit] && !havePendingJointRequest(unit)); });
			if (arrNewUnits.length > 0)
				requestJoints(ws, arrNewUnits);
		}
	);
}

function requestJoints(ws, arrUnits) {
	if (arrUnits.length === 0)
		return;
	arrUnits.forEach(function(unit){
		if (assocRequestedUnits[unit]){
			var diff = Date.now() - assocRequestedUnits[unit];
			if (diff <= STALLED_TIMEOUT)
				throw new Error("unit "+unit+" already requested "+diff+" ms ago, assocUnitsInWork="+assocUnitsInWork[unit]);
		}
		if (ws.readyState === ws.OPEN)
			assocRequestedUnits[unit] = Date.now();
		// even if readyState is not ws.OPEN, we still send the request, it'll be rerouted after timeout
		sendRequest(ws, 'get_joint', unit, true, handleResponseToJointRequest);
	});
}

function handleResponseToJointRequest(ws, request, response){
	if (!response.joint){
		if (response.joint_not_found === request.params)
			purgeDependenciesAndNotifyPeers(unit, "unit "+response.joint_not_found+" does not exist");
		// if it still exists, we'll request it again
		// we requst joints in two cases:
		// - when referenced from parents, in this case we request it from the same peer who sent us the referencing joint, 
		//   he should know, or he is attempting to DoS us
		// - when catching up and requesting old joints from random peers, in this case we are pretty sure it should exist
		return;
	}
	var objJoint = response.joint;
	if (!objJoint.unit || !objJoint.unit.unit)
		return sendError(ws, 'no unit');
	var unit = objJoint.unit.unit;
	if (request.params !== unit)
		return sendError(ws, "I didn't request this unit from you: "+unit);
	handleOnlineJoint(ws, objJoint);
}

function havePendingJointRequest(unit){
	var arrPeers = wss.clients.concat(arrOutboundPeers);
	for (var i=0; i<arrPeers.length; i++){
		var assocPendingRequests = arrPeers[i].assocPendingRequests;
		for (var tag in assocPendingRequests){
			var request = assocPendingRequests[tag].request;
			if (request.command === 'get_joint' && request.params === unit)
				return true;
		}
	}
	return false;
}

// We may receive a reference to a nonexisting unit in parents. We are not going to keep the referencing joint forever.
function purgeJunkUnhandledJoints(){
	if (bCatchingUp || Date.now() - coming_online_time < 3600*1000)
		return;
	db.query("DELETE FROM unhandled_joints WHERE creation_date < "+db.addTime("-1 HOUR"));
}

function purgeJointAndDependenciesAndNotifyPeers(objJoint, error, onDone){
	joint_storage.purgeJointAndDependencies(
		objJoint, 
		error, 
		// this callback is called for each dependent unit
		function(purged_unit, peer){
			var ws = getPeerWebSocket(peer);
			if (ws)
				sendErrorResult(ws, purged_unit, "error on (indirect) parent unit "+objJoint.unit.unit+": "+error);
		}, 
		onDone
	);
}

function purgeDependenciesAndNotifyPeers(unit, error, onDone){
	joint_storage.purgeDependencies(
		unit, 
		error, 
		// this callback is called for each dependent unit
		function(purged_unit, peer){
			var ws = getPeerWebSocket(peer);
			if (ws)
				sendErrorResult(ws, purged_unit, "error on (indirect) parent unit "+unit+": "+error);
		}, 
		onDone
	);
}

function forwardJoint(ws, objJoint){
	wss.clients.concat(arrOutboundPeers).forEach(function(client) {
		if (client != ws && client.bSubscribed)
			sendJoint(client, objJoint);
	});
}

function handleJoint(ws, objJoint, bSaved, callbacks){
	var unit = objJoint.unit.unit;

	if (assocUnitsInWork[unit])
		return callbacks.ifUnitInWork();
	assocUnitsInWork[unit] = true;
	
	var validate = function(){
		validation.validate(objJoint, {
			ifUnitError: function(error){
				console.log(objJoint.unit.unit+" validation failed: "+error);
				throw error;
				callbacks.ifUnitError(error);
				purgeJointAndDependenciesAndNotifyPeers(objJoint, error, function(){
					delete assocUnitsInWork[unit];
				});
				if (ws)
					writeEvent('invalid', ws.host);
				if (objJoint.unsigned)
					eventBus.emit("validated-"+unit, false);
			},
			ifJointError: function(error){
				throw error;
				callbacks.ifJointError(error);
				db.query(
					"INSERT INTO known_bad_joints (joint, json, error) VALUES (?,?,?)", 
					[objectHash.getJointHash(objJoint), JSON.stringify(objJoint), error],
					function(){
						delete assocUnitsInWork[unit];
					}
				);
				if (ws)
					writeEvent('invalid', ws.host);
				if (objJoint.unsigned)
					eventBus.emit("validated-"+unit, false);
			},
			ifTransientError: function(error){
				throw error;
				console.log("############################## transient error "+error);
				delete assocUnitsInWork[unit];
			},
			ifNeedHashTree: function(){
				if (objJoint.unsigned)
					throw "ifNeedHashTree() unsigned";
				callbacks.ifNeedHashTree();
				// we are not saving unhandled joint because we don't know dependencies
				delete assocUnitsInWork[unit];
			},
			ifNeedParentUnits: callbacks.ifNeedParentUnits,
			ifOk: function(objValidationState, validation_unlock){
				if (objJoint.unsigned)
					throw "ifOk() unsigned";
				writer.saveJoint(objJoint, objValidationState, null, function(){
					validation_unlock();
					if (ws)
						writeEvent((objValidationState.sequence !== 'good') ? 'nonserial' : 'new_good', ws.host);
					notifyWatchers(objJoint);
					if (!bCatchingUp)
						eventBus.emit('new_joint', objJoint);
					callbacks.ifOk();
				});
			},
			ifOkUnsigned: function(bSerial){
				if (!objJoint.unsigned)
					throw "ifOkUnsigned() signed";
				callbacks.ifOkUnsigned();
				eventBus.emit("validated-"+unit, bSerial);
			}
		});
	};

	joint_storage.checkIfNewJoint(objJoint, {
		ifNew: function(){
			bSaved ? callbacks.ifNew() : validate();
		},
		ifKnown: function(){
			callbacks.ifKnown();
			delete assocUnitsInWork[unit];
		},
		ifKnownBad: function(){
			callbacks.ifKnownBad();
			delete assocUnitsInWork[unit];
		},
		ifKnownUnverified: function(){
			bSaved ? validate() : callbacks.ifKnownUnverified();
		}
	});
}

// handle joint posted to me by a light client
function handlePostedJoint(ws, objJoint, onDone){
	
	var unit = objJoint.unit.unit;
	delete objJoint.unit.main_chain_index;
	
	handleJoint(ws, objJoint, false, {
		ifUnitInWork: function(){
			onDone("already handling this unit");
		},
		ifUnitError: function(error){
			onDone(error);
		},
		ifJointError: function(error){
			onDone(error);
		},
		ifNeedHashTree: function(){
			onDone("need hash tree");
		},
		ifNeedParentUnits: function(arrMissingUnits){
			onDone("unknown parents");
		},
		ifOk: function(){
			onDone();
			
			// forward to other peers
			if (!bCatchingUp && !conf.bLight)
				forwardJoint(ws, objJoint);

			delete assocUnitsInWork[unit];
		},
		ifOkUnsigned: function(){
			delete assocUnitsInWork[unit];
			onDone("you can't send unsigned units");
		},
		ifKnown: function(){
			if (objJoint.unsigned)
				throw "known unsigned";
			onDone("known");
			writeEvent('known_good', ws.host);
		},
		ifKnownBad: function(){
			onDone("known bad");
			writeEvent('known_bad', ws.host);
		},
		ifKnownUnverified: function(){ // impossible unless the peer also sends this joint by 'joint' justsaying
			onDone("known unverified");
			delete assocUnitsInWork[unit];
		}
	});
}

function handleOnlineJoint(ws, objJoint){
	
	var unit = objJoint.unit.unit;
	delete assocRequestedUnits[unit];
	delete objJoint.unit.main_chain_index;
	
	handleJoint(ws, objJoint, false, {
		ifUnitInWork: function(){},
		ifUnitError: function(error){
			sendErrorResult(ws, unit, error);
		},
		ifJointError: function(error){
			sendErrorResult(ws, unit, error);
		},
		ifNeedHashTree: function(){
			if (!bCatchingUp && !isWaitingForCatchupChain())
				requestCatchup(ws);
			// we are not saving the joint so that in case requestCatchup() fails, the joint will be requested again via findLostJoints, 
			// which will trigger another attempt to request catchup
		},
		ifNeedParentUnits: function(arrMissingUnits){
			sendInfo(ws, {unit: unit, info: "unresolved dependencies: "+arrMissingUnits.join(", ")});
			joint_storage.saveUnhandledJointAndDependencies(objJoint, arrMissingUnits, ws.peer, function(){
				delete assocUnitsInWork[unit];
			});
			requestNewMissingJoints(ws, arrMissingUnits);
		},
		ifOk: function(){
			sendResult(ws, {unit: unit, result: 'accepted'});
			
			// forward to other peers
			if (!bCatchingUp && !conf.bLight)
				forwardJoint(ws, objJoint);

			delete assocUnitsInWork[unit];

			// wake up other joints that depend on me
			findAndHandleJointsThatAreReady(unit);
		},
		ifOkUnsigned: function(){
			delete assocUnitsInWork[unit];
		},
		ifKnown: function(){
			if (objJoint.unsigned)
				throw "known unsigned";
			sendResult(ws, {unit: unit, result: 'known'});
			writeEvent('known_good', ws.host);
		},
		ifKnownBad: function(){
			sendResult(ws, {unit: unit, result: 'known_bad'});
			writeEvent('known_bad', ws.host);
			if (objJoint.unsigned)
				eventBus.emit("validated-"+unit, false);
		},
		ifKnownUnverified: function(){
			sendResult(ws, {unit: unit, result: 'known_unverified'});
			delete assocUnitsInWork[unit];
		}
	});
}


function handleSavedJoint(objJoint, creation_ts, peer){
	
	var unit = objJoint.unit.unit;
	var ws = getPeerWebSocket(peer);
	if (ws && ws.readyState !== ws.OPEN)
		ws = null;

	handleJoint(ws, objJoint, true, {
		ifUnitInWork: function(){},
		ifUnitError: function(error){
			if (ws)
				sendErrorResult(ws, unit, error);
		},
		ifJointError: function(error){
			if (ws)
				sendErrorResult(ws, unit, error);
		},
		ifNeedHashTree: function(){
			throw "handleSavedJoint: need hash tree";
		},
		ifNeedParentUnits: function(arrMissingUnits){
			throw Error("unit "+objJoint.unit.unit+" still has unresolved dependencies: "+arrMissingUnits.join(", "));
		},
		ifOk: function(){
			if (ws)
				sendResult(ws, {unit: unit, result: 'accepted'});
			
			// forward to other peers
			if (!bCatchingUp && !conf.bLight && creation_ts > Date.now() - FORWARDING_TIMEOUT)
				forwardJoint(ws, objJoint);

			joint_storage.removeUnhandledJointAndDependencies(unit, function(){
				delete assocUnitsInWork[unit];
				// wake up other saved joints that depend on me
				findAndHandleJointsThatAreReady(unit);
			});
		},
		ifOkUnsigned: function(){
			joint_storage.removeUnhandledJointAndDependencies(unit, function(){
				delete assocUnitsInWork[unit];
			});
		},
		// readDependentJointsThatAreReady can read the same joint twice before it's handled. If not new, just ignore (we've already responded to peer).
		ifKnown: function(){},
		ifKnownBad: function(){},
		ifNew: function(){
			throw "new in handleSavedJoint";
		}
	});
}


function setWatchedAddresses(_arrWatchedAddresses){
	arrWatchedAddresses = _arrWatchedAddresses;
}

function addWatchedAddress(address){
	arrWatchedAddresses.push(address);
}

// if any of the watched addresses are affected, notifies:  1. own UI  2. light clients
function notifyWatchers(objJoint){
	var objUnit = objJoint.unit;
	var arrAddresses = objUnit.authors.map(function(author){ return author.address; });
	for (var i=0; i<objUnit.messages.length; i++){
		var message = objUnit.messages[i];
		if (message.app !== "payment" || !message.payload)
			continue;
		var payload = message.payload;
		for (var j=0; j<payload.outputs.length; j++){
			var address = payload.outputs[j].address;
			if (arrAddresses.indexOf(address) === -1)
				arrAddresses.push(address);
		}
	}
	if (_.intersection(arrWatchedAddresses, arrAddresses).length > 0){
		eventBus.emit("new_my_transaction");
		eventBus.emit("new_my_unit-"+objJoint.unit.unit, objJoint);
	}
	
	// this is a new unstable joint, light clients will accept it without proof
	db.query("SELECT peer FROM watched_light_addresses WHERE address IN(?)", [arrAddresses], function(rows){
		if (rows.length === 0)
			return;
		objUnit.timestamp = Math.round(Date.now()/1000); // light clients need timestamp
		rows.forEach(function(row){
			var ws = getPeerWebSocket(row.peer);
			if (ws && ws.readyState === ws.OPEN)
				sendJoint(ws, objJoint);
		});
	});
}

eventBus.on('mci_became_stable', function(mci){
	process.nextTick(function(){ // don't call it synchronously with event emitter
		notifyWatchersAboutStableJoints(mci);
	});
});

function notifyWatchersAboutStableJoints(mci){
	// the event was emitted from inside mysql transaction, make sure it completes so that the changes are visible
	// If the mci became stable in determineIfStableInLaterUnitsAndUpdateStableMcFlag (rare), write lock is released before the validation commits, 
	// so we might not see this mci as stable yet. Hopefully, it'll complete before light/have_updates roundtrip
	mutex.lock(["write"], function(unlock){
		unlock(); // we don't need to block writes, we requested the lock just to wait that the current write completes
		notifyLocalWatchedAddressesAboutStableJoints(mci);
		console.log("notifyWatchersAboutStableJoints "+mci);
		if (mci <= 1)
			return;
		storage.findLastBallMciOfMci(db, mci, function(last_ball_mci){
			storage.findLastBallMciOfMci(db, mci-1, function(prev_last_ball_mci){
				if (prev_last_ball_mci === last_ball_mci)
					return;
				notifyLightClientsAboutStableJoints(prev_last_ball_mci, last_ball_mci);
			});
		});
	});
}

// from_mci is non-inclusive, to_mci is inclusive
function notifyLightClientsAboutStableJoints(from_mci, to_mci){
	db.query(
		"SELECT peer FROM units JOIN unit_authors USING(unit) JOIN watched_light_addresses USING(address) \n\
		WHERE main_chain_index>? AND main_chain_index<=? \n\
		UNION \n\
		SELECT peer FROM units JOIN outputs USING(unit) JOIN watched_light_addresses USING(address) \n\
		WHERE main_chain_index>? AND main_chain_index<=?",
		[from_mci, to_mci, from_mci, to_mci],
		function(rows){
			rows.forEach(function(row){
				var ws = getPeerWebSocket(row.peer);
				if (ws && ws.readyState === ws.OPEN)
					sendJustsaying(ws, 'light/have_updates');
			});
		}
	);
}

function notifyLocalWatchedAddressesAboutStableJoints(mci){
	if (arrWatchedAddresses.length === 0)
		return;
	db.query(
		"SELECT 1 FROM units JOIN unit_authors USING(unit) WHERE main_chain_index=? AND address IN(?) \n\
		UNION \n\
		SELECT 1 FROM units JOIN outputs USING(unit) WHERE main_chain_index=? AND address IN(?)",
		[mci, arrWatchedAddresses, mci, arrWatchedAddresses],
		function(rows){
			if (rows.length > 0)
				eventBus.emit('my_transaction_became_stable');
		}
	);
}


function writeEvent(event, host){
	db.query("INSERT INTO peer_events (peer_host, event) VALUES (?,?)", [host, event]);
	if (event === 'new_good' || event === 'invalid' || event === 'nonserial'){
		var column = "count_"+event+"_joints";
		db.query("UPDATE peer_hosts SET "+column+"="+column+"+1 WHERE peer_host=?", [host]);
	}
}

function findAndHandleJointsThatAreReady(unit){
	joint_storage.readDependentJointsThatAreReady(unit, handleSavedJoint);
	handleSavedPrivatePayments(unit);
}

function comeOnline(){
	bCatchingUp = false;
	coming_online_time = Date.now();
	waitTillIdle(requestFreeJointsFromAllOutboundPeers);
	eventBus.emit('catching_up_done');
}

function isIdle(){
	//console.log(db._freeConnections.length +"/"+ db._allConnections.length+" connections are free, "+mutex.getCountOfQueuedJobs()+" jobs queued, "+mutex.getCountOfLocks()+" locks held, "+Object.keys(assocUnitsInWork).length+" units in work");
	return (db.getCountUsedConnections() === 0 && mutex.getCountOfQueuedJobs() === 0 && mutex.getCountOfLocks() === 0 && Object.keys(assocUnitsInWork).length === 0);
}

function waitTillIdle(onIdle){
	if (isIdle()){
		bWaitingTillIdle = false;
		onIdle();
	}
	else{
		bWaitingTillIdle = true;
		setTimeout(function(){
			waitTillIdle(onIdle);
		}, 100);
	}
}

function broadcastJoint(objJoint){
	if (conf.bLight) // the joint was already posted to light vendor before saving
		return;
	wss.clients.concat(arrOutboundPeers).forEach(function(client) {
		if (client.bSubscribed)
			sendJoint(client, objJoint);
	});
	notifyWatchers(objJoint);
}



// catchup

function requestCatchup(ws){
	console.log("will request catchup");
	eventBus.emit('catching_up_started');
	catchup.purgeHandledBallsFromHashTree(db, function(){
		db.query(
			"SELECT hash_tree_balls.unit FROM hash_tree_balls LEFT JOIN units USING(unit) WHERE units.unit IS NULL ORDER BY ball_index", 
			function(tree_rows){ // leftovers from previous run
				if (tree_rows.length > 0){
					bCatchingUp = true;
					console.log("will request balls found in hash tree");
					requestNewMissingJoints(ws, tree_rows.map(function(tree_row){ return tree_row.unit; }));
					waitTillHashTreeFullyProcessedAndRequestNext(ws);
					return;
				}
				db.query("SELECT 1 FROM catchup_chain_balls LIMIT 1", function(chain_rows){ // leftovers from previous run
					if (chain_rows.length > 0){
						bCatchingUp = true;
						requestNextHashTree(ws);
						return;
					}
					// we are not switching to catching up mode until we receive a catchup chain - don't allow peers to throw us into 
					// catching up mode by just sending a ball
					
					// to avoid duplicate requests, we are raising this flag before actually sending the request 
					// (will also reset the flag only after the response is fully processed)
					ws.bWaitingForCatchupChain = true;
					
					storage.readLastStableMcIndex(db, function(last_stable_mci){
						storage.readLastMainChainIndex(function(last_known_mci){
							myWitnesses.readMyWitnesses(function(arrWitnesses){
								var params = {witnesses: arrWitnesses, last_stable_mci: last_stable_mci, last_known_mci: last_known_mci};
								sendRequest(ws, 'catchup', params, true, handleCatchupChain);
							}, 'wait');
						});
					});
				});
			}
		);
	});
}

function handleCatchupChain(ws, request, response){
	if (response.error){
		ws.bWaitingForCatchupChain = false;
		console.log('catchup request got error response: '+response.error);
		// findLostJoints will wake up and trigger another attempt to request catchup
		/*setTimeout(function(){
			findNextPeer(ws, function(next_ws){
				requestCatchup(next_ws);
			});
		}, 1000);*/
		return;
	}
	var catchupChain = response;
	catchup.processCatchupChain(catchupChain, ws.peer, {
		ifError: function(error){
			ws.bWaitingForCatchupChain = false;
			sendError(ws, error);
		},
		ifOk: function(){
			ws.bWaitingForCatchupChain = false;
			bCatchingUp = true;
			requestNextHashTree(ws);
		},
		ifCurrent: function(){
			ws.bWaitingForCatchupChain = false;
		}
	});
}

function isWaitingForCatchupChain(){
	return wss.clients.concat(arrOutboundPeers).some(function(ws) { return ws.bWaitingForCatchupChain; });
}


// hash tree

function requestNextHashTree(ws){
	db.query("SELECT ball FROM catchup_chain_balls ORDER BY member_index LIMIT 2", function(rows){
		if (rows.length === 0)
			return comeOnline();
		if (rows.length === 1){
			db.query("DELETE FROM catchup_chain_balls WHERE ball=?", [rows[0].ball], function(){
				comeOnline();
			});
			return;
		}
		var from_ball = rows[0].ball;
		var to_ball = rows[1].ball;
		
		// don't send duplicate requests
		for (var tag in ws.assocPendingRequests)
			if (ws.assocPendingRequests[tag].request.command === 'get_hash_tree'){
				console.log("already requested hash tree from this peer");
				return;
			}
		sendRequest(ws, 'get_hash_tree', {from_ball: from_ball, to_ball: to_ball}, true, handleHashTree);
	});
}

function handleHashTree(ws, request, response){
	if (response.error){
		console.log('get_hash_tree got error response: '+response.error);
		waitTillHashTreeFullyProcessedAndRequestNext(ws); // after 1 sec, it'll request the same hash tree, likely from another peer
		return;
	}
	var hashTree = response;
	catchup.processHashTree(hashTree.balls, {
		ifError: function(error){
			sendError(ws, error);
			waitTillHashTreeFullyProcessedAndRequestNext(ws); // after 1 sec, it'll request the same hash tree, likely from another peer
		},
		ifOk: function(){
			requestNewMissingJoints(ws, hashTree.balls.map(function(objBall){ return objBall.unit; }));
			waitTillHashTreeFullyProcessedAndRequestNext(ws);
		}
	});
}

function waitTillHashTreeFullyProcessedAndRequestNext(ws){
	setTimeout(function(){
		db.query("SELECT 1 FROM hash_tree_balls LEFT JOIN units USING(unit) WHERE units.unit IS NULL LIMIT 1", function(rows){
			if (rows.length === 0){
				findNextPeer(ws, function(next_ws){
					requestNextHashTree(next_ws);
				});
			}
			else
				waitTillHashTreeFullyProcessedAndRequestNext(ws);
		});
	}, 1000);
}




// private payments

function sendPrivatePaymentToWs(ws, arrChains){
	// each chain is sent as separate ws message
	arrChains.forEach(function(arrPrivateElements){
		sendJustsaying(ws, 'private_payment', arrPrivateElements);
	});
}

// sends multiple private payloads and their corresponding chains
function sendPrivatePayment(peer, arrChains){
	var ws = getPeerWebSocket(peer);
	if (ws)
		return sendPrivatePaymentToWs(ws, arrChains);
	findOutboundPeerOrConnect(peer, function(err, ws){
		if (!err)
			sendPrivatePaymentToWs(ws, arrChains);
	});
}

// handles one private payload and its chain
function handleOnlinePrivatePayment(ws, arrPrivateElements, bViaHub, callbacks){
	if (!ValidationUtils.isNonemptyArray(arrPrivateElements))
		return callbacks.ifError("private_payment content must be non-empty array");
	
	var unit = arrPrivateElements[0].unit;
	var message_index = arrPrivateElements[0].message_index;

	var savePrivatePayment = function(cb){
		db.query(
			"INSERT INTO unhandled_private_payments (unit, message_index, json, peer) VALUES (?,?,?,?)", 
			[unit, message_index, JSON.stringify(arrPrivateElements), bViaHub ? '' : ws.peer], // forget peer if received via hub
			function(){
				callbacks.ifQueued();
				if (cb)
					cb();
			}
		);
	};
	
	if (conf.bLight && arrPrivateElements.length > 1){
		savePrivatePayment(function(){
			updateLinkProofsOfPrivateChain(arrPrivateElements, unit, message_index);
		});
		return;
	}

	joint_storage.checkIfNewUnit(unit, {
		ifKnown: function(){
			//assocUnitsInWork[unit] = true;
			privatePayment.validateAndSavePrivatePaymentChain(arrPrivateElements, {
				ifOk: function(){
					//delete assocUnitsInWork[unit];
					callbacks.ifAccepted(unit);
					eventBus.emit("new_my_transaction");
				},
				ifError: function(error){
					//delete assocUnitsInWork[unit];
					callbacks.ifValidationError(unit, error);
				},
				ifWaitingForChain: function(){
					savePrivatePayment();
				}
			});
		},
		ifNew: function(){
			savePrivatePayment();
			// if received via hub, I'm requesting from the same hub, thus telling the hub that this unit contains a private payment for me.
			// It would be better to request missing joints from somebody else
			requestNewMissingJoints(ws, [unit]);
		},
		ifKnownUnverified: savePrivatePayment
	});
}
	
// if unit is undefined, find units that are ready
function handleSavedPrivatePayments(unit){
	//if (unit && assocUnitsInWork[unit])
	//    return;
	mutex.lock(["saved_private"], function(unlock){
		var sql = unit
			? "SELECT json, peer, unit, message_index, linked FROM unhandled_private_payments WHERE unit="+db.escape(unit)
			: "SELECT json, peer, unit, message_index, linked FROM unhandled_private_payments JOIN units USING(unit)";
		db.query(sql, function(rows){
			if (rows.length === 0)
				return unlock();
			var count_new = 0;
			async.each( // handle different chains in parallel
				rows,
				function(row, cb){
					var arrPrivateElements = JSON.parse(row.json);
					var ws = getPeerWebSocket(row.peer);
					if (ws && ws.readyState !== ws.OPEN)
						ws = null;
					
					var validateAndSave = function(){
						var objHeadPrivateElement = arrPrivateElements[0];
						var payload_hash = objectHash.getBase64Hash(objHeadPrivateElement.payload);
						var key = 'private_payment_validated-'+objHeadPrivateElement.unit+'-'+payload_hash;
						privatePayment.validateAndSavePrivatePaymentChain(arrPrivateElements, {
							ifOk: function(){
								if (ws)
									sendResult(ws, {private_payment_in_unit: row.unit, result: 'accepted'});
								if (row.peer) // received directly from a peer, not through the hub
									eventBus.emit("new_direct_private_chains", [arrPrivateElements]);
								count_new++;
								deleteHandledPrivateChain(row.unit, row.message_index, cb);
								eventBus.emit(key, true);
							},
							ifError: function(error){
								console.log("validation of priv: "+error);
								throw error;
								if (ws)
									sendResult(ws, {private_payment_in_unit: row.unit, result: 'error', error: error});
								deleteHandledPrivateChain(row.unit, row.message_index, cb);
								eventBus.emit(key, false);
							},
							// light only. Means that chain joints (excluding the head) not downloaded yet or not stable yet
							ifWaitingForChain: function(){
								cb();
							}
						});
					};
					
					if (conf.bLight && arrPrivateElements.length > 1 && !row.linked)
						updateLinkProofsOfPrivateChain(arrPrivateElements, row.unit, row.message_index, cb, validateAndSave);
					else
						validateAndSave();
					
				},
				function(){
					unlock();
					if (count_new > 0)
						eventBus.emit("new_my_transaction");
				}
			);
		});
	});
}

function deleteHandledPrivateChain(unit, message_index, cb){
	db.query("DELETE FROM unhandled_private_payments WHERE unit=? AND message_index=?", [unit, message_index], function(){
		cb();
	});
}

function rerequestLostJointsOfPrivatePayments(){
	if (!conf.bLight)
		return;
	db.query(
		"SELECT DISTINCT unhandled_private_payments.unit FROM unhandled_private_payments LEFT JOIN units USING(unit) WHERE units.unit IS NULL",
		function(rows){
			if (rows.length === 0)
				return;
			var arrUnits = rows.map(function(row){ return row.unit; });
			findOutboundPeerOrConnect(exports.light_vendor_url, function(err, ws){
				if (err)
					return;
				requestNewMissingJoints(ws, arrUnits);
			});
		}
	);
}

// light only
function requestUnfinishedPastUnitsOfPrivateChains(arrChains, onDone){
	if (!onDone)
		onDone = function(){};
	privatePayment.findUnfinishedPastUnitsOfPrivateChains(arrChains, function(arrUnits){
		if (arrUnits.length === 0)
			return onDone();
		requestProofsOfJoints(arrUnits, onDone);
	});
}

function requestProofsOfJoints(arrUnits, onDone){
	if (!onDone)
		onDone = function(){};
	myWitnesses.readMyWitnesses(function(arrWitnesses){
		var objHistoryRequest = {witnesses: arrWitnesses, requested_joints: arrUnits};
		requestFromLightVendor('light/get_history', objHistoryRequest, function(ws, request, response){
			if (response.error){
				console.log(response.error);
				return onDone();
			}
			light.processHistory(response, {
				ifError: function(err){
					network.sendError(ws, err);
					onDone();
				},
				ifOk: function(){
					onDone();
				}
			});
		});
	}, 'wait');
}

function requestProofsOfJointsIfNewOrUnstable(arrUnits, onDone){
	if (!onDone)
		onDone = function(){};
	storage.filterNewOrUnstableUnits(arrUnits, function(arrNewOrUnstableUnits){
		if (arrNewOrUnstableUnits.length === 0)
			return onDone();
		requestProofsOfJoints(arrUnits, onDone);
	});
}

// light only
function requestUnfinishedPastUnitsOfSavedPrivateElements(){
	db.query("SELECT json FROM unhandled_private_payments", function(rows){
		if (rows.length === 0)
			return;
		var arrChains = [];
		rows.forEach(function(row){
			var arrPrivateElements = JSON.parse(row.json);
			arrChains.push(arrPrivateElements);
		});
		requestUnfinishedPastUnitsOfPrivateChains(arrChains);
	});
}

// light only
// Note that we are leaking to light vendor information about the full chain. 
// If the light vendor was a party to any previous transaction in this chain, he'll know how much we received.
function checkThatEachChainElementIncludesThePrevious(arrPrivateElements, handleResult){
	if (arrPrivateElements.length === 1) // an issue
		return handleResult(true);
	var arrUnits = arrPrivateElements.map(function(objPrivateElement){ return objPrivateElement.unit; });
	requestFromLightVendor('light/get_link_proofs', arrUnits, function(ws, request, response){
		if (response.error)
			return handleResult(null); // undefined result
		var arrChain = response;
		if (!ValidationUtils.isNonemptyArray(arrChain))
			return handleResult(null); // undefined result
		light.processLinkProofs(arrUnits, arrChain, {
			ifError: function(err){
				console.log("linkproof validation failed: "+err);
				throw err;
				handleResult(false);
			},
			ifOk: function(){
				console.log("linkproof validated ok");
				handleResult(true);
			}
		});
	});
}

// light only
function updateLinkProofsOfPrivateChain(arrPrivateElements, unit, message_index, onFailure, onSuccess){
	if (!conf.bLight)
		throw "light but updateLinkProofsOfPrivateChain";
	if (!onFailure)
		onFailure = function(){};
	if (!onSuccess)
		onSuccess = function(){};
	checkThatEachChainElementIncludesThePrevious(arrPrivateElements, function(bLinked){
		if (bLinked === null)
			return onFailure();
		if (!bLinked)
			return deleteHandledPrivateChain(unit, message_index, onFailure);
		db.query("UPDATE unhandled_private_payments SET linked=1 WHERE unit=? AND message_index=?", [unit, message_index], function(){
			onSuccess();
		});
	});
}

function initWitnessesIfNecessary(ws, onDone){
	onDone = onDone || function(){};
	myWitnesses.readMyWitnesses(function(arrWitnesses){
		if (arrWitnesses.length > 0) // already have witnesses
			return onDone();
		sendRequest(ws, 'get_witnesses', null, false, function(ws, request, arrWitnesses){
			myWitnesses.insertWitnesses(arrWitnesses, onDone);
		});
	}, 'ignore');
}

// hub

function sendStoredDeviceMessages(ws, device_address){
	db.query("SELECT message_hash, message FROM device_messages WHERE device_address=? ORDER BY creation_date LIMIT 100", [device_address], function(rows){
		rows.forEach(function(row){
			sendJustsaying(ws, 'hub/message', {message_hash: row.message_hash, message: JSON.parse(row.message)});
		});
		sendInfo(ws, rows.length+" messages sent");
	});
}


// switch/case different message types

function handleJustsaying(ws, subject, body){
	switch (subject){
		case 'refresh':
			if (bCatchingUp)
				return;
			var mci = body;
			if (ValidationUtils.isNonnegativeInteger(mci))
				return sendJointsSinceMci(ws, mci);
			else
				return sendFreeJoints(ws);
			
		case 'version':
			if (body.protocol_version !== constants.version){
				sendError(ws, 'Incompatible versions, mine '+constants.version+', yours '+body.protocol_version);
				ws.close(1000, 'incompatible versions');
				return;
			}
			if (body.alt !== constants.alt){
				sendError(ws, 'Incompatible alts, mine '+constants.alt+', yours '+body.alt);
				ws.close(1000, 'incompatible alts');
				return;
			}
			break;
		
		case 'bugreport':
			mail.sendBugEmail(body.message, body.exception);
			break;
			
		case 'joint':
			var objJoint = body;
			if (!objJoint.unit || !objJoint.unit.unit)
				return sendError(ws, 'no unit');
			if (objJoint.ball)
				return sendError(ws, 'only requested joint can contain a ball');
			if (conf.bLight && !ws.bLightVendor)
				return sendError(ws, "I'm a light client and you are not my vendor");
			// light clients accept the joint without proof, it'll be saved as unconfirmed (non-stable)
			return handleOnlineJoint(ws, objJoint);
			
		case 'free_joints_end':
		case 'result':
		case 'info':
		case 'error':
			break;
			
		case 'private_payment':
			var arrPrivateElements = body;
			handleOnlinePrivatePayment(ws, arrPrivateElements, false, {
				ifError: function(error){
					sendError(ws, error);
				},
				ifAccepted: function(unit){
					sendResult(ws, {private_payment_in_unit: unit, result: 'accepted'});
					eventBus.emit("new_direct_private_chains", [arrPrivateElements]);
				},
				ifValidationError: function(unit, error){
					sendResult(ws, {private_payment_in_unit: unit, result: 'error', error: error});
				},
				ifQueued: function(){
				}
			});
			break;
			
		case 'my_url':
			var url = body;
			if (ws.bOutbound) // ignore: if you are outbound, I already know your url
				break;
			// inbound only
			if (ws.bAdvertisedOwnUrl) // allow it only once per connection
				break;
			ws.bAdvertisedOwnUrl = true;
			if (url.indexOf('ws://') !== 0 && url.indexOf('wss://') !== 0) // invalid url
				break;
			ws.claimed_url = url;
			db.query("SELECT MAX(creation_date) AS latest_url_change_date, url FROM peer_host_urls WHERE peer_host=?", [ws.host], function(rows){
				var latest_change = rows[0];
				if (latest_change.url === url) // advertises the same url
					return;
				//var elapsed_time = Date.now() - Date.parse(latest_change.latest_url_change_date);
				//if (elapsed_time < 24*3600*1000) // change allowed no more often than once per day
				//    return;
				
				// verify it is really your url by connecting to this url, sending a random string through this new connection, 
				// and expecting this same string over existing inbound connection
				ws.sent_echo_string = crypto.randomBytes(30).toString("base64");
				findOutboundPeerOrConnect(url, function(err, reverse_ws){
					if (!err)
						sendJustsaying(reverse_ws, 'want_echo', ws.sent_echo_string);
				});
			});
			break;
			
		case 'want_echo':
			var echo_string = body;
			if (ws.bOutbound) // ignore
				break;
			// inbound only
			if (!ws.claimed_url)
				break;
			var reverse_ws = getOutboundPeerWsByUrl(ws.claimed_url);
			if (!reverse_ws) // no reverse outbound connection
				break;
			sendJustsaying(reverse_ws, 'your_echo', echo_string);
			break;
			
		case 'your_echo': // comes on the same ws as my_url, claimed_url is already set
			var echo_string = body;
			if (ws.bOutbound) // ignore
				break;
			// inbound only
			if (!ws.claimed_url)
				break;
			if (ws.sent_echo_string !== echo_string)
				break;
			var outbound_host = getHostByPeer(ws.claimed_url);
			var arrQueries = [];
			db.addQuery(arrQueries, "INSERT "+db.getIgnore()+" INTO peer_hosts (peer_host) VALUES (?)", [outbound_host]);
			db.addQuery(arrQueries, "INSERT "+db.getIgnore()+" INTO peers (peer_host, peer, learnt_from_peer_host) VALUES (?,?,?)", 
				[outbound_host, ws.claimed_url, ws.host]);
			db.addQuery(arrQueries, "UPDATE peer_host_urls SET is_active=NULL, revocation_date="+db.getNow()+" WHERE peer_host=?", [ws.host]);
			db.addQuery(arrQueries, "INSERT INTO peer_host_urls (peer_host, url) VALUES (?,?)", [ws.host, ws.claimed_url]);
			async.series(arrQueries);
			ws.sent_echo_string = null;
			break;
			
			
		// I'm a hub, the peer wants to authenticate
		case 'hub/login':
			if (!conf.bServeAsHub)
				return sendError(ws, "I'm not a hub");
			var objLogin = body;
			if (objLogin.challenge !== ws.challenge)
				return sendError(ws, "wrong challenge");
			if (!objLogin.pubkey || !objLogin.signature)
				return sendError(ws, "no login params");
			if (objLogin.pubkey.length !== constants.PUBKEY_LENGTH)
				return sendError(ws, "wrong pubkey length");
			if (!ecdsaSig.verify(objectHash.getDeviceMessageHashToSign(objLogin), objLogin.signature, objLogin.pubkey))
				return sendError(ws, "wrong signature");
			ws.device_address = objectHash.getDeviceAddress(objLogin.pubkey);
			// after this point the device is authenticated and can send further commands
			db.query("SELECT 1 FROM devices WHERE device_address=?", [ws.device_address], function(rows){
				if (rows.length === 0)
					db.query("INSERT INTO devices (device_address, pubkey) VALUES (?,?)", [ws.device_address, objLogin.pubkey], function(){
						sendInfo(ws, "address created");
					});
				else
					sendStoredDeviceMessages(ws, ws.device_address);
			});
			break;
			
		// I'm a hub, the peer wants to download new messages
		case 'hub/refresh':
			if (!conf.bServeAsHub)
				return sendError(ws, "I'm not a hub");
			if (!ws.device_address)
				return sendError(ws, "please log in first");
			sendStoredDeviceMessages(ws, ws.device_address);
			break;
			
		// I'm a hub, the peer wants to remove a message that he's just handled
		case 'hub/delete':
			if (!conf.bServeAsHub)
				return sendError(ws, "I'm not a hub");
			var message_hash = body;
			if (!message_hash)
				return sendError(ws, "no message hash");
			if (!ws.device_address)
				return sendError(ws, "please log in first");
			db.query("DELETE FROM device_messages WHERE device_address=? AND message_hash=?", [ws.device_address, message_hash], function(){
				sendInfo(ws, "deleted message "+message_hash);
			});
			break;
			
		// I'm connected to a hub
		case 'hub/challenge':
		case 'hub/message':
			eventBus.emit("message_from_hub", ws, subject, body);
			break;
			
		// I'm light client
		case 'light/have_updates':
			if (!conf.bLight)
				return sendError(ws, "I'm not light");
			if (!ws.bLightVendor)
				return sendError(ws, "You are not my light vendor");
			eventBus.emit("message_for_light", ws, subject, body);
			break;
			
		// I'm light vendor
		case 'light/new_address_to_watch':
			if (conf.bLight)
				return sendError(ws, "I'm light myself, can't serve you");
			if (ws.bOutbound)
				return sendError(ws, "light clients have to be inbound");
			var address = body;
			if (!ValidationUtils.isValidAddress(address))
				return sendError(ws, "address not valid");
			db.query("INSERT "+db.getIgnore()+" INTO watched_light_addresses (peer, address) VALUES (?,?)", [ws.peer, address], function(){
				sendInfo(ws, "now watching "+address);
			});            
			break;
	}
}

function handleRequest(ws, tag, command, params){
	if (ws.assocInPreparingResponse[tag]) // ignore repeated request while still preparing response to a previous identical request
		return console.log("ignoring identical "+command+" request");
	ws.assocInPreparingResponse[tag] = true;
	switch (command){
		case 'heartbeat':
			sendResponse(ws, tag);
			break;
			
		case 'subscribe':
			if (!ValidationUtils.isNonemptyObject(params))
				return sendErrorResponse(ws, tag, 'no params');
			var subscription_id = params.subscription_id;
			if (typeof subscription_id !== 'string')
				return sendErrorResponse(ws, tag, 'no subscription_id');
			if (wss.clients.concat(arrOutboundPeers).some(function(other_ws) { return (other_ws.subscription_id === subscription_id); })){
				if (ws.bOutbound)
					db.query("UPDATE peers SET is_self=1 WHERE peer=?", [ws.peer]);
				sendErrorResponse(ws, tag, "self-connect");
				return ws.close(1000, "self-connect");
			}
			if (conf.bLight){
				//if (ws.peer === exports.light_vendor_url)
				//    sendFreeJoints(ws);
				return sendErrorResponse(ws, tag, "I'm light, cannot subscribe you to updates");
			}
			ws.bSubscribed = true;
			sendResponse(ws, tag, "subscribed");
			if (bCatchingUp)
				return;
			if (ValidationUtils.isNonnegativeInteger(params.last_mci))
				sendJointsSinceMci(ws, params.last_mci);
			else
				sendFreeJoints(ws);
			break;
			
		case 'get_joint': // peer needs a specific joint
			//if (bCatchingUp)
			//    return;
			var unit = params;
			storage.readJoint(db, unit, {
				ifFound: function(objJoint){
					sendJoint(ws, objJoint, tag);
				},
				ifNotFound: function(){
					sendResponse(ws, tag, {joint_not_found: unit});
				}
			});
			break;
			
		case 'post_joint': // only light clients use this command to post joints they created
			var objJoint = params;
			handlePostedJoint(ws, objJoint, function(error){
				error ? sendErrorResponse(ws, tag, error) : sendResponse(ws, tag, 'accepted');
			});
			break;
			
		case 'catchup':
			var catchupRequest = params;
			catchup.prepareCatchupChain(catchupRequest, {
				ifError: function(error){
					sendErrorResponse(ws, tag, error);
				},
				ifOk: function(objCatchupChain){
					sendResponse(ws, tag, objCatchupChain);
				}
			});
			break;
			
		case 'get_hash_tree':
			var hashTreeRequest = params;
			catchup.readHashTree(hashTreeRequest, {
				ifError: function(error){
					sendErrorResponse(ws, tag, error);
				},
				ifOk: function(arrBalls){
					// we have to wrap arrBalls into an object because the peer will check .error property first
					sendResponse(ws, tag, {balls: arrBalls});
				}
			});
			break;
			
		case 'get_peers':
			var arrPeerUrls = arrOutboundPeers.map(function(ws){ return ws.peer; });
			// empty array is ok
			sendResponse(ws, tag, arrPeerUrls);
			break;
			
		case 'get_witnesses':
			myWitnesses.readMyWitnesses(function(arrWitnesses){
				sendResponse(ws, tag, arrWitnesses);
			}, 'wait');
			break;
			
		// I'm a hub, the peer wants to deliver a message to one of my clients
		case 'hub/deliver':
			var objDeviceMessage = params;
			if (!objDeviceMessage || !objDeviceMessage.signature || !objDeviceMessage.pubkey || !objDeviceMessage.to
					|| !objDeviceMessage.encrypted_package || !objDeviceMessage.encrypted_package.dh
					|| !objDeviceMessage.encrypted_package.dh.sender_ephemeral_pubkey 
					|| !objDeviceMessage.encrypted_package.encrypted_message
					|| !objDeviceMessage.encrypted_package.iv || !objDeviceMessage.encrypted_package.authtag)
				return sendErrorResponse(ws, tag, "missing fields");
			var bToMe = (my_device_address && my_device_address === objDeviceMessage.to);
			if (!conf.bServeAsHub && !bToMe)
				return sendErrorResponse(ws, tag, "I'm not a hub");
			if (!ecdsaSig.verify(objectHash.getDeviceMessageHashToSign(objDeviceMessage), objDeviceMessage.signature, objDeviceMessage.pubkey))
				return sendErrorResponse(ws, tag, "wrong message signature");
			
			// if i'm always online and i'm my own hub
			if (bToMe){
				sendResponse(ws, tag, "accepted");
				eventBus.emit("message_from_hub", ws, 'hub/message', objDeviceMessage);
				return;
			}
			
			db.query("SELECT 1 FROM devices WHERE device_address=?", [objDeviceMessage.to], function(rows){
				if (rows.length === 0)
					return sendErrorResponse(ws, tag, "address "+objDeviceMessage.to+" not registered here");
				var message_hash = objectHash.getBase64Hash(objDeviceMessage);
				db.query(
					"INSERT "+db.getIgnore()+" INTO device_messages (message_hash, message, device_address) VALUES (?,?,?)", 
					[message_hash, JSON.stringify(objDeviceMessage), objDeviceMessage.to],
					function(){
						// if the adressee is connected, deliver immediately
						wss.clients.forEach(function(client){
							if (client.device_address === objDeviceMessage.to)
								sendJustsaying(client, 'hub/message', {message_hash: message_hash, message: objDeviceMessage});
						});
						sendResponse(ws, tag, "accepted");
					}
				);
			});
			break;
			
		// I'm a hub, the peer wants to get a correspondent's temporary pubkey
		case 'hub/get_temp_pubkey':
			var permanent_pubkey = params;
			if (!permanent_pubkey)
				return sendErrorResponse(ws, tag, "no permanent_pubkey");
			if (permanent_pubkey.length !== constants.PUBKEY_LENGTH)
				return sendErrorResponse(ws, tag, "wrong permanent_pubkey length");
			var device_address = objectHash.getDeviceAddress(permanent_pubkey);
			if (device_address === my_device_address) // to me
				return sendResponse(ws, tag, objMyTempPubkeyPackage); // this package signs my permanent key
			if (!conf.bServeAsHub)
				return sendErrorResponse(ws, tag, "I'm not a hub");
			db.query("SELECT temp_pubkey_package FROM devices WHERE device_address=?", [device_address], function(rows){
				if (rows.length === 0)
					return sendErrorResponse(ws, tag, "device with this pubkey is not registered here");
				if (!rows[0].temp_pubkey_package)
					return sendErrorResponse(ws, tag, "temp pub key not set yet");
				var objTempPubkey = JSON.parse(rows[0].temp_pubkey_package);
				sendResponse(ws, tag, objTempPubkey);
			});
			break;
			
		// I'm a hub, the peer wants to update its temporary pubkey
		case 'hub/temp_pubkey':
			if (!conf.bServeAsHub)
				return sendErrorResponse(ws, tag, "I'm not a hub");
			if (!ws.device_address)
				return sendErrorResponse(ws, tag, "please log in first");
			var objTempPubkey = params;
			if (!objTempPubkey.temp_pubkey || !objTempPubkey.pubkey || !objTempPubkey.signature)
				return sendErrorResponse(ws, tag, "no temp_pubkey params");
			if (objTempPubkey.temp_pubkey.length !== constants.PUBKEY_LENGTH)
				return sendErrorResponse(ws, tag, "wrong temp_pubkey length");
			if (objectHash.getDeviceAddress(objTempPubkey.pubkey) !== ws.device_address)
				return sendErrorResponse(ws, tag, "signed by another pubkey");
			if (!ecdsaSig.verify(objectHash.getDeviceMessageHashToSign(objTempPubkey), objTempPubkey.signature, objTempPubkey.pubkey))
				return sendErrorResponse(ws, tag, "wrong signature");
			db.query("UPDATE devices SET temp_pubkey_package=? WHERE device_address=?", [JSON.stringify(objTempPubkey), ws.device_address], function(){
				sendResponse(ws, tag, "updated");
			});
			break;
			
		case 'light/get_history':
			if (conf.bLight)
				return sendErrorResponse(ws, tag, "I'm light myself, can't serve you");
			if (ws.bOutbound)
				return sendErrorResponse(ws, tag, "light clients have to be inbound");
			light.prepareHistory(params, {
				ifError: function(err){
					sendErrorResponse(ws, tag, err);
				},
				ifOk: function(objResponse){
					sendResponse(ws, tag, objResponse);
					if (params.addresses)
						db.query(
							"INSERT "+db.getIgnore()+" INTO watched_light_addresses (peer, address) VALUES "+
							params.addresses.map(function(address){ return "("+db.escape(ws.peer)+", "+db.escape(address)+")"; }).join(", ")
						);
					//db.query("INSERT "+db.getIgnore()+" INTO light_peer_witnesses (peer, witness_address) VALUES "+
					//    params.witnesses.map(function(address){ return "("+db.escape(ws.peer)+", "+db.escape(address)+")"; }).join(", "));
				}
			});
			break;
			
		case 'light/get_link_proofs':
			if (conf.bLight)
				return sendErrorResponse(ws, tag, "I'm light myself, can't serve you");
			if (ws.bOutbound)
				return sendErrorResponse(ws, tag, "light clients have to be inbound");
			light.prepareLinkProofs(params, {
				ifError: function(err){
					sendErrorResponse(ws, tag, err);
				},
				ifOk: function(objResponse){
					sendResponse(ws, tag, objResponse);
				}
			});
			break;
			
	   case 'light/get_parents_and_last_ball_and_witness_list_unit':
			if (conf.bLight)
				return sendErrorResponse(ws, tag, "I'm light myself, can't serve you");
			if (ws.bOutbound)
				return sendErrorResponse(ws, tag, "light clients have to be inbound");
			light.prepareParentsAndLastBallAndWitnessListUnit(params.witnesses, {
				ifError: function(err){
					sendErrorResponse(ws, tag, err);
				},
				ifOk: function(objResponse){
					sendResponse(ws, tag, objResponse);
				}
			});
			break;
	}
}

function onWebsocketMessage(message) {
		
	var ws = this;
	
	if (ws.readyState !== ws.OPEN)
		return;
	
	console.log('RECEIVED '+message+' from '+ws.peer);
	ws.last_ts = Date.now();
	
	var arrMessage = JSON.parse(message);
	var message_type = arrMessage[0];
	var content = arrMessage[1];
	
	switch (message_type){
		case 'justsaying':
			return handleJustsaying(ws, content.subject, content.body);
			
		case 'request':
			return handleRequest(ws, content.tag, content.command, content.params);
			
		case 'response':
			return handleResponse(ws, content.tag, content.response);
			
		default: 
			throw "unknown type: "+message_type;
	}
}

function startAcceptingConnections(){
	db.query("DELETE FROM watched_light_addresses");
	//db.query("DELETE FROM light_peer_witnesses");
	// listen for new connections
	wss = new WebSocketServer({ port: conf.port });
	wss.on('connection', function(ws) {
		var ip = ws.upgradeReq.connection.remoteAddress;
		if (ws.upgradeReq.headers['x-real-ip'] && (ip === '127.0.0.1' || ip.match(/^192\.168\./))) // we are behind a proxy
			ip = ws.upgradeReq.headers['x-real-ip'];
		if (wss.clients.length >= MAX_INBOUND_CONNECTIONS){
			console.log("inbound connections maxed out, rejecting new client "+ip);
			ws.close(1000, "inbound connections maxed out"); // 1001 doesn't work in cordova
			return;
		}
		ws.peer = ip + ":" + ws.upgradeReq.connection.remotePort;
		ws.host = ip;
		ws.assocPendingRequests = {};
		ws.assocInPreparingResponse = {};
		ws.bInbound = true;
		ws.last_ts = Date.now();
		console.log('got connection from '+ws.peer+", host "+ws.host);
		var bStatsCheckUnderWay = true;
		db.query(
			"SELECT \n\
				SUM(CASE WHEN event='invalid' THEN 1 ELSE 0 END) AS count_invalid, \n\
				SUM(CASE WHEN event='new_good' THEN 1 ELSE 0 END) AS count_new_good \n\
				FROM peer_events WHERE peer_host=? AND event_date>"+db.addTime("-1 HOUR"), [ws.host],
			function(rows){
				var stats = rows[0];
				if (stats.count_invalid){
					console.log("rejecting new client "+ws.host+" because of bad stats");
					ws.terminate();
				}
				bStatsCheckUnderWay = false;
			}
		);
		ws.on('message', function(message){ // might come earlier than stats check completes
			function tryHandleMessage(){
				if (bStatsCheckUnderWay)
					setTimeout(tryHandleMessage, 100);
				else
					onWebsocketMessage.call(ws, message);
			}
			tryHandleMessage();
		});
		ws.on('close', function(){
			db.query("DELETE FROM watched_light_addresses WHERE peer=?", [ws.peer]);
			//db.query("DELETE FROM light_peer_witnesses WHERE peer=?", [ws.peer]);
			console.log("client "+ws.peer+" disconnected");
			cancelRequestsOnClosedConnection(ws);
		});
		ws.on('error', function(e){
			console.log("error on client "+ws.peer+": "+e);
			ws.close(1000, "received error");
		});
		addPeerHost(ws.host);

		// welcome the new peer with the list of free joints
		//if (!bCatchingUp)
		//    sendFreeJoints(ws);
		
		sendVersion(ws);
		
		// I'm a hub, send challenge
		if (conf.bServeAsHub){
			ws.challenge = crypto.randomBytes(30).toString("base64");
			sendJustsaying(ws, 'hub/challenge', ws.challenge);
		}
		if (!conf.bLight)
			subscribe(ws);
	});
	console.log('WSS running at port ' + conf.port);
}

function startRelay(){
	if (process.browser || !conf.port) // no listener on mobile
		wss = {clients: []};
	else
		startAcceptingConnections();
	
	// outbound connections
	addOutboundPeers();
	
	// request needed joints that were not received during the previous session
	rerequestLostJoints();

	// retry lost and failed connections every 1 minute
	setInterval(addOutboundPeers, 60*1000);
	setTimeout(checkIfHaveEnoughOutboundPeersAndAdd, 30*1000);
	setInterval(rerequestLostJoints, 8*1000);
	setInterval(purgeJunkUnhandledJoints, 30*60*1000);
	setInterval(joint_storage.purgeUncoveredNonserialJointsUnderLock, 6*1000);
	setInterval(findAndHandleJointsThatAreReady, 5*1000);
}

function startLightClient(){
	wss = {clients: []};
	rerequestLostJointsOfPrivatePayments();
	setInterval(rerequestLostJointsOfPrivatePayments, 5*1000);
	setInterval(handleSavedPrivatePayments, 5*1000);
	setInterval(requestUnfinishedPastUnitsOfSavedPrivateElements, 12*1000);
}

function start(){
	console.log("starting network");
	conf.bLight ? startLightClient() : startRelay();
	setInterval(printConnectionStatus, 6*1000);
	// if we have exactly same intervals on two clints, they might send heartbeats to each other at the same time
	setInterval(heartbeat, 3*1000 + getRandomInt(0, 1000));
}

start();

exports.start = start;
exports.postJointToLightVendor = postJointToLightVendor;
exports.broadcastJoint = broadcastJoint;
exports.sendPrivatePayment = sendPrivatePayment;

exports.sendJustsaying = sendJustsaying;
exports.sendError = sendError;
exports.sendRequest = sendRequest;
exports.findOutboundPeerOrConnect = findOutboundPeerOrConnect;
exports.handleOnlineJoint = handleOnlineJoint;

exports.handleOnlinePrivatePayment = handleOnlinePrivatePayment;
exports.requestUnfinishedPastUnitsOfPrivateChains = requestUnfinishedPastUnitsOfPrivateChains;
exports.requestProofsOfJointsIfNewOrUnstable = requestProofsOfJointsIfNewOrUnstable;

exports.requestFromLightVendor = requestFromLightVendor;

exports.addPeer = addPeer;

exports.initWitnessesIfNecessary = initWitnessesIfNecessary;

exports.setMyDeviceProps = setMyDeviceProps;

exports.setWatchedAddresses = setWatchedAddresses;
exports.addWatchedAddress = addWatchedAddress;
