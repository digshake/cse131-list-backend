'use strict';

import { APIGatewayProxyHandler, APIGatewayProxyEvent } from 'aws-lambda';
import 'source-map-support/register';


import { User, validateLoginRequest, validateTokenRequest, PermissionLevel, checkClassPermissions, validate, ClassObj, getUserByUsername, createUser, addExistingUserToClass, getClassName, validateArray } from './utility/security';
import { wrapper } from './utility/responses';
import { DynamoDBUpdateParams, performUpdate, DynamoDBPutParams, performPut, updateUser, performScan, DynamoDBScanParams, DynamoDBGetParams, performGet, DynamoDBDeleteParams, performDelete} from './utility/database';
import {ErrorTypes, GeneratedError} from './utility/responses';
import { createList, ListWrapper } from './utility/list';
import { sendMessageToUser, WebSocketMessages } from './utility/websocket';

const randtoken = require('rand-token');

//Checked
export const login: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(async ()=>{
    const query = parseInput(event)
    return await validateLoginRequest(query);
  });
}

//Checked
export const logout: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(async ()=>{
    const query = parseInput(event)
    await validateTokenRequest(query);
    await updateUser(query.id,"SET tokenTime = :t2",{":t2": 0});
  });
}

const addClassToUser = async (userId: string, classId: string) => {
  const addToClass: DynamoDBUpdateParams = {
    TableName: process.env.USER_TABLE,
    Key: {id:userId}, //https://stackoverflow.com/questions/41400538/append-a-new-object-to-a-json-array-in-dynamodb-using-nodejs
    UpdateExpression: 'set #classes = list_append(if_not_exists(#classes, :empty_list), :newClass)',
    ExpressionAttributeNames: {
      '#classes' : 'classes'
    },
    ExpressionAttributeValues: {
      ':empty_list': [],
      ':newClass': [classId]
    }
  }
  await performUpdate(addToClass)
}
//Checked
export const createClass: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event)
    await validateTokenRequest(query,true);
    validate(query.className,"string","className",1,50)
    const newClass: ClassObj = {
      id: randtoken.generate(32),
      classUsers: {},
      className: query.className,
      userCode: randtoken.generate(10),
      taCode: randtoken.generate(10),
      adminCode: randtoken.generate(10),
      sessions: {}
    }
    newClass.classUsers[query.id] = PermissionLevel.Professor
    const createClassQuery: DynamoDBPutParams = {
      TableName: process.env.CLASS_TABLE,
      Item: newClass
    }
    await performPut(createClassQuery)
    await addClassToUser(query.id,newClass.id)
  });
}

export const deleteClass: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event)
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.changingClass,PermissionLevel.Professor)
    const getUsers: DynamoDBGetParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.changingClass},
      ProjectionExpression: 'classUsers'
    }
    const classUsers: ClassObj = await performGet(getUsers)
    //Delete class from users
    await Promise.all(Object.keys(classUsers.classUsers).map(async user => {
      //Copied from createUpdateClassMembership consolodate
      const getRemovedUser: DynamoDBGetParams = {
        TableName: process.env.USER_TABLE,
        Key: {id: user},
        ProjectionExpression: 'classes'
      }
      //https://hackernoon.com/safe-list-updates-with-dynamodb-adc44f2e7d3
      const oldClasses = await performGet(getRemovedUser)
      const indexToRemove = oldClasses.classes.indexOf(query.changingClass)
      const removeClassEnrollment: DynamoDBUpdateParams = {
        TableName: process.env.USER_TABLE,
        Key: {id:user},
        UpdateExpression: `remove classes[${indexToRemove}]`,
        ConditionExpression: `classes[${indexToRemove}] = :valueToRemove`,
        ExpressionAttributeValues: {
          ':valueToRemove': query.changingClass
        }
      }
      await performUpdate(removeClassEnrollment)
    }));
    //TODO delete all appropriate sessions
    const deleteRequest: DynamoDBDeleteParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.changingClass}
    }
    await performDelete(deleteRequest)
  });
}
//This is good because professor for class doesn't need to know what other classes a student is in(and shouldn't know)
export const createUpdateClassMembership: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event)
    await validateTokenRequest(query);
    validate(query.changingClass,'string','changingClass',32,32)
    validate(query.removeUser,'boolean','removeUser')
    validate(query.subjectUsername,"string","subjectUsername",1,50)
    await checkClassPermissions(query.id,query.changingClass,PermissionLevel.Professor)
    let existingUser: User = await getUserByUsername(query.subjectUsername,true)
    if(existingUser && !existingUser.classes.includes(query.changingClass) && query.removeUser) {
      throw new GeneratedError(ErrorTypes.UserNotInClass);
    }
    if(existingUser === null) {
      validate(query.newPermissionLevel,'number','newPermissionLevel',PermissionLevel.Student,PermissionLevel.Professor)
      validate(query.subjectName,"string","subjectName",1,100)
      await createUser(query.subjectUsername,false,query.subjectName,query.changingClass,query.newPermissionLevel)
    } else {
      if(query.removeUser) {
        const getRemovedUser: DynamoDBGetParams = {
          TableName: process.env.USER_TABLE,
          Key: {id: existingUser.id},
          ProjectionExpression: 'classes'
        }
        //https://hackernoon.com/safe-list-updates-with-dynamodb-adc44f2e7d3
        const oldClasses = await performGet(getRemovedUser)
        const indexToRemove = oldClasses.classes.indexOf(query.changingClass)
        const removeClassEnrollment: DynamoDBUpdateParams = {
          TableName: process.env.USER_TABLE,
          Key: {id:existingUser.id},
          UpdateExpression: `remove classes[${indexToRemove}]`,
          ConditionExpression: `classes[${indexToRemove}] = :valueToRemove`,
          ExpressionAttributeValues: {
            ':valueToRemove': query.changingClass
          }
        }
        await performUpdate(removeClassEnrollment)
        const removeUserEnrollment: DynamoDBUpdateParams = {
          TableName: process.env.CLASS_TABLE,
          Key: {id:query.changingClass},
          UpdateExpression: `remove classUsers.#existingId`,
          ExpressionAttributeNames: {
            '#existingId': existingUser.id
          }
        }
        await performUpdate(removeUserEnrollment)
      } else {
        validate(query.newPermissionLevel,'number','newPermissionLevel',PermissionLevel.Student,PermissionLevel.Professor)
        if(!existingUser.classes.includes(query.changingClass)) { //Only add class to user if doesn't exist, else permissions may just be changing
          await addClassToUser(existingUser.id,query.changingClass);
        }
        await addExistingUserToClass(query.changingClass,existingUser.id,query.newPermissionLevel)
      }
    }
  });
}

export const createUpdateAdminStatus: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event)
    validate(query.newAdminStatus,'boolean','newAdminStatus')
    validate(query.subjectUsername,"string","subjectUsername",1,50)
    await validateTokenRequest(query,true);
    let existingUser: User = await getUserByUsername(query.subjectUsername,true)
    if(existingUser === null) {
      validate(query.subjectName,"string","subjectName",1,100)
      await createUser(query.subjectUsername,query.newAdminStatus,query.subjectName)
    } else {
      await updateUser(existingUser.id,'set admin = :newStatus',{':newStatus': query.newAdminStatus});
    }
  });
}

export const getAdminInfo: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event)
    await validateTokenRequest(query, true);
    const request: DynamoDBScanParams  = {
      TableName: process.env.USER_TABLE,
      ProjectionExpression: "id, fullName, username",
      FilterExpression: 'admin = :t',
      ExpressionAttributeValues: {
        ":t": true
      }
    }
    let adminUsers: User[] = await performScan(request)
    return adminUsers
  });
}


export const getClassInfo: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event)
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Student)
    const request: DynamoDBGetParams  = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      ProjectionExpression: "classUsers.#givenUser, sessions",
      ExpressionAttributeNames: {
        "#givenUser": query.id
      }
    }
    return await performGet(request) as ClassObj
  });
}

export const getClassAdminInfo: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event)
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
    const request: DynamoDBGetParams  = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      ProjectionExpression: "classUsers, userCode, taCode, adminCode"
    }
    const result : {classUsers: object, userCode: string, taCode: string, adminCode: string}= await performGet(request);
    result.classUsers = await Promise.all(Object.entries(result.classUsers).map(async ([user,permissionLevel])=>{
      const userInfoRequest: DynamoDBGetParams = {
        TableName: process.env.USER_TABLE,
        Key: {id: user},
        ProjectionExpression: 'id, username, fullName'
      }
      const result = await performGet(userInfoRequest);
      result.permissionLevel = permissionLevel;
      return result
    }))
    return result;
  });
}

export const refreshUserInfo: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event);
    await validateTokenRequest(query);
    const request: DynamoDBGetParams = {
      TableName: process.env.USER_TABLE,
      Key: {id: query.id},
      ProjectionExpression: 'classes, username, fullName, admin'
    }
    let result =  await performGet(request)
    //Copied from login function make function to not duplicate
    result.classes = await Promise.all((result.classes as string[]).map(async id=>{
      const className =  await getClassName(id);
      return {id, className}
    }))
    return result
  })
}

export const setUserInfo: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event);
    await validateTokenRequest(query);
    await validate(query.newName,'string','newName',1,50);
    // const existingUser = await getUserByUsername(query.newUsername,true)
    // if(existingUser !== null && existingUser.id !== query.id) {
    //   throw new GeneratedError(ErrorTypes.UsernameAlreadyExists)
    // }
    const request: DynamoDBUpdateParams = {
      TableName: process.env.USER_TABLE,
      Key: {id: query.id},
      UpdateExpression: 'set fullName = :newName',
      ExpressionAttributeValues: {
        ':newName': query.newName
      }
    }
    await performUpdate(request)
  })
}

export const setClassName: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event);
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
    validate(query.newClassName,'string','newClassName',1,50)
    const request: DynamoDBUpdateParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      UpdateExpression: 'set className = :newClassName',
      ExpressionAttributeValues: {
        ':newClassName': query.newClassName
      },
      ReturnValues: 'UPDATED_NEW'
    }
    const result = await performUpdate(request)
    return {className: result.Attributes.className, id: query.classId}
  })
}

export const createSession: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event);
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
    validate(query.newSessionName,'string','newSessionName',1,50)
    validateArray(query.startingLists, 'string', 'startingLists')
    const getClassInfoParams: DynamoDBGetParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      ProjectionExpression: 'className',
    }
    const classInfo = await performGet(getClassInfoParams) as ClassObj
    const newListArray = await Promise.all(query.startingLists.map(async name => {
      const newList = await createList(query.classId,query.id,'List '+name+' in Class '+classInfo.className);
      const result = {}
      result[newList.id] = name
      return result
    }))
    //https://stackoverflow.com/questions/27538349/merge-multiple-objects-inside-the-same-array-into-one-object
    const newListObj = newListArray.reduce(((r, c) => Object.assign(r, c)), {})
    const createClassSession: DynamoDBUpdateParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      UpdateExpression: 'set sessions.#sessionId = :defaultLists',
      ExpressionAttributeNames: {
        '#sessionId': randtoken.generate(32)
      },
      ExpressionAttributeValues: {
        ':defaultLists': {sessionName: query.newSessionName, lists: newListObj} //TODO check unique names
      }
    }
    await performUpdate(createClassSession)
  });
}

export const closeSession: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event);
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
    validate(query.sessionId,'string','sessionId',32,32)
    const getClassInfoParams: DynamoDBGetParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      ProjectionExpression: 'sessions.#sessionId',
      ExpressionAttributeNames: {
        '#sessionId': query.sessionId
      }
    }
    const classInfo = await performGet(getClassInfoParams) as ClassObj
    if(classInfo.sessions[query.sessionId]) {
      await Promise.all(Object.keys(classInfo.sessions[query.sessionId].lists).map(async list_name => {
        const list = new ListWrapper(list_name)
        await list.closeList(event)
      }))
    } else {
      throw new GeneratedError(ErrorTypes.SessionDoesNotExist)
    }
    const removeSessionInfoParams: DynamoDBUpdateParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      UpdateExpression: 'remove sessions.#sessionId',
      ExpressionAttributeNames: {
        '#sessionId': query.sessionId
      }
    }
    await performUpdate(removeSessionInfoParams)
  });
}

export const helpNextUser: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  console.log(Date.now());
  return wrapper(async ()=> {
    const query = parseInput(event, true);
    await validateTokenRequest(query);
    const list = new ListWrapper(query.list_id)
    let positionInfo = (await list.getIndexOfUser(query.id));
    console.log(positionInfo)
    if(positionInfo.index !== -1) {
      await list.helpUser(query.id,0,event) //Gets first user
    } else {
      throw new GeneratedError(ErrorTypes.ConnectionNotInSession)
    }
  });
}

export const joinList: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
    return wrapper(async ()=> {
      const query = parseInput(event, true);
      await validateTokenRequest(query);
      const list = new ListWrapper(query.list_id)
      let positionInfo;
      try {
        positionInfo = (await list.getIndexOfUser(query.id));
      } catch {
        //In cases of failure, IE list doesn't exist as it has been closed
        await sendMessageToUser(query.id, event.requestContext.connectionId, '',WebSocketMessages.CloseListSession,event,list);   
        return;
      }
      if(positionInfo.index !== -1) {
        Object.assign(positionInfo, await list.updateConnectionForUser(query.id,event.requestContext.connectionId));
      } else {
        positionInfo = await list.addUser(query.id,event.requestContext.connectionId, event);
      }
      await sendMessageToUser(query.id, event.requestContext.connectionId, positionInfo,WebSocketMessages.InitalizeSession,event,list);   
    });
}

export const leaveList: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event, true);
    await validateTokenRequest(query);
    const list = new ListWrapper(query.list_id)
    await list.removeUserFromList(query.id, event);
  });
}

export const flagUser: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event, true);
    await validateTokenRequest(query);
    const list = new ListWrapper(query.list_id)
    await list.flagUser(query.id, query.studentName, query.message, event);
  });
}

export const helpFlaggedUser: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event, true);
    await validateTokenRequest(query);
    const list = new ListWrapper(query.list_id)
    await list.helpFlagUser(query.id, query.studentName, query.message, event);
  });
}

export const selfAddClass: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event);
    await validateTokenRequest(query);
    validate(query.classCode,'string','classCode',10,10)
    const request: DynamoDBScanParams  = {
      TableName: process.env.CLASS_TABLE,
      ProjectionExpression: "id, userCode, taCode, adminCode",
      FilterExpression: 'userCode = :t or taCode = :t or adminCode = :t',
      ExpressionAttributeValues: {
        ":t": query.classCode
      }
    }
    let classes: ClassObj[] = await performScan(request);
    if(classes.length === 0) {
      throw new GeneratedError(ErrorTypes.InvalidInput);
    }
    let givenClass = classes[0];
    const newPermissionLevel: PermissionLevel = givenClass.userCode === query.classCode ? PermissionLevel.Student : givenClass.taCode === query.classCode ? PermissionLevel.TA : givenClass.adminCode === query.classCode ? PermissionLevel.Professor : -1;
    const userParams: DynamoDBGetParams = {
      TableName: process.env.USER_TABLE,
      Key: {id: query.id},
      ProjectionExpression: "classes"
    };
    const existingUser = await performGet(userParams);
    if(existingUser && existingUser.classes.includes(givenClass.id)) {
      throw new GeneratedError(ErrorTypes.UserAlreadyInClass);
    }
    await addExistingUserToClass(givenClass.id,query.id,newPermissionLevel);
    await addClassToUser(query.id,givenClass.id);
  });
}

export const getFullOverview: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event, true);
    await validateTokenRequest(query);
    const list = new ListWrapper(query.list_id)
    await list.getFullOverview(query.id, event);
  });
}

const parseInput = (event, websocket = false) => {
  try {
    const query = JSON.parse(event.body);
    if(query === null || typeof query !== 'object') {
      throw new GeneratedError(ErrorTypes.InvalidInput);
    }
    return websocket ? query.data : query;
  } catch (e) {
    throw new GeneratedError(ErrorTypes.InvalidInput);
  }
}

